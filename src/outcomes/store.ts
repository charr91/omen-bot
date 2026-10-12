import type { Pool } from 'pg';
import type { OutcomeRow, TradeSide } from './scoring.js';

export const CREATE_TRADE_OUTCOMES_TABLE_SQL = `
  create table if not exists trade_outcomes (
    fill_id text primary key,
    kind text not null check (kind in ('signal', 'baseline')),
    ref_fill_id text,
    signal_ids text[] not null default '{}',
    delivery_tier text,
    wallet_address text not null,
    market_id text not null,
    token_id text not null,
    side text not null,
    size_usd numeric not null,
    alert_at timestamptz not null,
    price_at_alert numeric not null,
    price_1h numeric,
    price_1h_checked_at timestamptz,
    price_24h numeric,
    price_24h_checked_at timestamptz,
    resolution_price numeric,
    resolved_at timestamptz,
    resolution_checked_at timestamptz,
    baseline_sampled boolean not null default false,
    volume_spike boolean,
    volume_spike_multiplier double precision,
    created_at timestamptz not null default now()
  );
`;

export const CREATE_TRADE_OUTCOMES_INDEXES_SQL = [
  'create index if not exists idx_trade_outcomes_kind_alert_at on trade_outcomes (kind, alert_at);',
  'create index if not exists idx_trade_outcomes_market on trade_outcomes (market_id);',
  'create index if not exists idx_trade_outcomes_ref on trade_outcomes (ref_fill_id);',
  "alter table trade_outcomes add column if not exists venue text not null default 'polymarket';",
];

export type Venue = 'polymarket' | 'kalshi';

export type Horizon = '1h' | '24h';

export interface PendingPriceRow {
  fillId: string;
  tokenId: string;
  targetAt: Date;
  venue: Venue;
}

export interface SignalRowForContext {
  fillId: string;
  marketId: string;
  alertAt: Date;
}

export interface OutcomeQueryRow extends OutcomeRow {
  signalIds: string[];
  deliveryTier: string | null;
}

const TIER_RANK_SQL = `case delivery_tier when 'CRITICAL' then 4 when 'HIGH' then 3 when 'MEDIUM' then 2 when 'LOW' then 1 else 0 end`;

export function createTradeOutcomeStore(pool: Pick<Pool, 'query'>) {
  return {
    /** Enrolls every fill that produced a signal event (one row per fill, all its signal ids, highest alert tier). */
    async enrollSignalFills(since: Date): Promise<number> {
      const result = await pool.query(
        `
          insert into trade_outcomes (
            fill_id, kind, signal_ids, delivery_tier, wallet_address, market_id, token_id, side, size_usd,
            alert_at, price_at_alert
          )
          select
            f.id, 'signal', s.signal_ids, t.delivery_tier, lower(f.wallet_address), f.market_id, f.token_id, f.side,
            f.size_usd, f.timestamp, f.price
          from (
            select fill_id, array_agg(distinct signal_id order by signal_id) as signal_ids
            from signal_events
            where created_at >= $1
            group by fill_id
          ) s
          join fills f on f.id = s.fill_id
          left join lateral (
            select delivery_tier from alerts a where a.fill_id = s.fill_id
            order by ${TIER_RANK_SQL} desc limit 1
          ) t on true
          where f.price > 0 and f.price < 1
          on conflict (fill_id) do nothing
        `,
        [since],
      );
      return result.rowCount ?? 0;
    },

    /**
     * Samples up to `perSignal` ordinary fills per signal fill: same market, within +/- windowHours, size between
     * half and double the signal fill, from a different wallet, never itself a signal fill or a known market maker.
     */
    async sampleBaselines(perSignal: number, windowHours: number, limit: number, excludedWallets: string[]): Promise<number> {
      const pending = await pool.query<{ fill_id: string }>(
        // Wait until the whole +/- window has been ingested before sampling.
        `select fill_id from trade_outcomes
         where kind = 'signal' and venue = 'polymarket' and not baseline_sampled
           and alert_at <= now() - make_interval(hours => $2)
         order by alert_at limit $1`,
        [limit, windowHours],
      );
      let inserted = 0;
      for (const { fill_id: refFillId } of pending.rows) {
        const result = await pool.query(
          `
            insert into trade_outcomes (
              fill_id, kind, ref_fill_id, signal_ids, delivery_tier, wallet_address, market_id, token_id, side,
              size_usd, alert_at, price_at_alert
            )
            select f.id, 'baseline', r.fill_id, r.signal_ids, r.delivery_tier, lower(f.wallet_address), f.market_id,
              f.token_id, f.side, f.size_usd, f.timestamp, f.price
            from trade_outcomes r
            join fills f on f.market_id = r.market_id
            where r.fill_id = $1
              and f.timestamp between r.alert_at - make_interval(hours => $3) and r.alert_at + make_interval(hours => $3)
              and f.size_usd between r.size_usd / 2 and r.size_usd * 2
              and lower(f.wallet_address) <> r.wallet_address
              and not (lower(f.wallet_address) = any($4::text[]))
              and f.price > 0 and f.price < 1
              and not exists (select 1 from signal_events se where se.fill_id = f.id)
              and not exists (select 1 from trade_outcomes o where o.fill_id = f.id)
            order by random()
            limit $2
            on conflict (fill_id) do nothing
          `,
          [refFillId, perSignal, windowHours, excludedWallets],
        );
        inserted += result.rowCount ?? 0;
        await pool.query(`update trade_outcomes set baseline_sampled = true where fill_id = $1`, [refFillId]);
      }
      return inserted;
    },

    async listPendingPrices(horizon: Horizon, now: Date, retryAfterMs: number, limit: number): Promise<PendingPriceRow[]> {
      const offset = horizon === '1h' ? '1 hour' : '24 hours';
      const result = await pool.query<{ fill_id: string; token_id: string; target_at: Date; venue: Venue }>(
        `
          select fill_id, token_id, venue, alert_at + interval '${offset}' as target_at
          from trade_outcomes
          where price_${horizon} is null
            and alert_at + interval '${offset}' <= $1
            and alert_at + interval '${offset}' >= $1 - interval '7 days'
            and (price_${horizon}_checked_at is null or price_${horizon}_checked_at <= $2)
          order by alert_at
          limit $3
        `,
        [now, new Date(now.getTime() - retryAfterMs), limit],
      );
      return result.rows.map((row) => ({ fillId: row.fill_id, tokenId: row.token_id, targetAt: row.target_at, venue: row.venue }));
    },

    async setPrice(horizon: Horizon, fillId: string, price: number | null, now: Date): Promise<void> {
      await pool.query(
        `update trade_outcomes set price_${horizon} = coalesce($2, price_${horizon}), price_${horizon}_checked_at = $3 where fill_id = $1`,
        [fillId, price, now],
      );
    },

    /** Fallback price source: the closest ingested fill for the same token within +/- windowMs. */
    async findNearestFillPrice(tokenId: string, at: Date, windowMs: number): Promise<number | null> {
      const result = await pool.query<{ price: string }>(
        `
          select price::text from fills
          where token_id = $1 and timestamp between $2 and $3
          order by abs(extract(epoch from (timestamp - $4::timestamptz))) limit 1
        `,
        [tokenId, new Date(at.getTime() - windowMs), new Date(at.getTime() + windowMs), at],
      );
      const price = Number(result.rows[0]?.price ?? Number.NaN);
      return Number.isFinite(price) ? price : null;
    },

    async listUnresolvedMarkets(now: Date, retryAfterMs: number, limit: number, venue: Venue = 'polymarket'): Promise<string[]> {
      const result = await pool.query<{ market_id: string }>(
        `
          select market_id from trade_outcomes
          where resolution_price is null and venue = $3
            and (resolution_checked_at is null or resolution_checked_at <= $1)
          group by market_id
          order by min(alert_at)
          limit $2
        `,
        [new Date(now.getTime() - retryAfterMs), limit, venue],
      );
      return result.rows.map((row) => row.market_id);
    },

    /** Enrolls Kalshi signals (market-level, no wallet): token/market id = ticker, BUY = expects YES up. */
    async enrollKalshiSignals(since: Date): Promise<number> {
      const result = await pool.query(
        `
          insert into trade_outcomes (
            fill_id, kind, signal_ids, delivery_tier, wallet_address, market_id, token_id, side, size_usd,
            alert_at, price_at_alert, venue, volume_spike
          )
          select 'kalshi:' || id, 'signal', array[signal_id], 'KALSHI', '', ticker, ticker,
            case side when 'yes' then 'BUY' else 'SELL' end, coalesce(size_usd, 0), at, yes_price, 'kalshi', false
          from kalshi_signals
          where at >= $1 and yes_price > 0 and yes_price < 1
          on conflict (fill_id) do nothing
        `,
        [since],
      );
      return result.rowCount ?? 0;
    },

    /**
     * Kalshi baseline: ordinary stored prints (non-block) on the same ticker within +/- windowHours; when the
     * signal has a size (block/large print) the baseline is limited to 0.5-2x that notional.
     */
    async sampleKalshiBaselines(perSignal: number, windowHours: number, limit: number): Promise<number> {
      const pending = await pool.query<{ fill_id: string }>(
        `select fill_id from trade_outcomes
         where kind = 'signal' and venue = 'kalshi' and not baseline_sampled
           and alert_at <= now() - make_interval(hours => $2)
         order by alert_at limit $1`,
        [limit, windowHours],
      );
      let inserted = 0;
      for (const { fill_id: refFillId } of pending.rows) {
        const result = await pool.query(
          `
            insert into trade_outcomes (
              fill_id, kind, ref_fill_id, signal_ids, delivery_tier, wallet_address, market_id, token_id, side,
              size_usd, alert_at, price_at_alert, venue, volume_spike
            )
            select 'kalshi-trade:' || t.trade_id, 'baseline', r.fill_id, r.signal_ids, r.delivery_tier, '', t.ticker,
              t.ticker, case t.taker_side when 'yes' then 'BUY' else 'SELL' end, t.notional_usd, t.created_at,
              t.yes_price, 'kalshi', false
            from trade_outcomes r
            join kalshi_trades t on t.ticker = r.market_id
            where r.fill_id = $1
              and t.created_at between r.alert_at - make_interval(hours => $3) and r.alert_at + make_interval(hours => $3)
              and not t.is_block_trade
              and (r.size_usd = 0 or t.notional_usd between r.size_usd / 2 and r.size_usd * 2)
              and t.yes_price > 0 and t.yes_price < 1
              and not exists (select 1 from kalshi_signals s where s.trade_id = t.trade_id)
              and not exists (select 1 from trade_outcomes o where o.fill_id = 'kalshi-trade:' || t.trade_id)
            order by random()
            limit $2
            on conflict (fill_id) do nothing
          `,
          [refFillId, perSignal, windowHours],
        );
        inserted += result.rowCount ?? 0;
        await pool.query(`update trade_outcomes set baseline_sampled = true where fill_id = $1`, [refFillId]);
      }
      return inserted;
    },

    /** Kalshi fallback price: closest stored print on the ticker within +/- windowMs. */
    async findNearestKalshiPrice(ticker: string, at: Date, windowMs: number): Promise<number | null> {
      const result = await pool.query<{ price: string }>(
        `select yes_price::text as price from kalshi_trades
         where ticker = $1 and created_at between $2 and $3
         order by abs(extract(epoch from (created_at - $4::timestamptz))) limit 1`,
        [ticker, new Date(at.getTime() - windowMs), new Date(at.getTime() + windowMs), at],
      );
      const price = Number(result.rows[0]?.price ?? Number.NaN);
      return Number.isFinite(price) ? price : null;
    },

    async getKalshiEventTicker(ticker: string): Promise<string | null> {
      const result = await pool.query<{ event_ticker: string }>(`select event_ticker from kalshi_markets where ticker = $1`, [ticker]);
      return result.rows[0]?.event_ticker ?? null;
    },

    async markMarketsChecked(marketIds: string[], now: Date): Promise<void> {
      if (marketIds.length === 0) return;
      await pool.query(
        `update trade_outcomes set resolution_checked_at = $2 where resolution_price is null and market_id = any($1::text[])`,
        [marketIds, now],
      );
    },

    async setResolution(marketId: string, tokenPrices: Record<string, number>, resolvedAt: Date | null): Promise<number> {
      let updated = 0;
      for (const [tokenId, price] of Object.entries(tokenPrices)) {
        const result = await pool.query(
          `update trade_outcomes set resolution_price = $3, resolved_at = $4
           where market_id = $1 and token_id = $2 and resolution_price is null`,
          [marketId, tokenId, price, resolvedAt],
        );
        updated += result.rowCount ?? 0;
      }
      return updated;
    },

    async listSignalRowsMissingContext(limit: number): Promise<SignalRowForContext[]> {
      const result = await pool.query<{ fill_id: string; market_id: string; alert_at: Date }>(
        `select fill_id, market_id, alert_at from trade_outcomes
         where kind = 'signal' and venue = 'polymarket' and volume_spike is null order by alert_at limit $1`,
        [limit],
      );
      return result.rows.map((row) => ({ fillId: row.fill_id, marketId: row.market_id, alertAt: row.alert_at }));
    },

    async listMarketHourlyVolume(marketId: string, from: Date, to: Date): Promise<Array<{ hour: Date; volumeUsd: number }>> {
      const result = await pool.query<{ hour: Date; volume: string }>(
        `select date_trunc('hour', timestamp) as hour, sum(size_usd)::text as volume from fills
         where market_id = $1 and timestamp >= $2 and timestamp < $3 group by 1`,
        [marketId, from, to],
      );
      return result.rows.map((row) => ({ hour: row.hour, volumeUsd: Number(row.volume) }));
    },

    async setVolumeContext(fillId: string, isSpike: boolean, multiplier: number): Promise<void> {
      await pool.query(`update trade_outcomes set volume_spike = $2, volume_spike_multiplier = $3 where fill_id = $1`, [
        fillId,
        isSpike,
        Number.isFinite(multiplier) ? multiplier : null,
      ]);
    },

    async listOutcomes(since: Date): Promise<OutcomeQueryRow[]> {
      const result = await pool.query<{
        kind: 'signal' | 'baseline';
        side: TradeSide;
        signal_ids: string[];
        delivery_tier: string | null;
        price_at_alert: string;
        price_1h: string | null;
        price_24h: string | null;
        resolution_price: string | null;
      }>(
        `select kind, side, signal_ids, delivery_tier, price_at_alert::text, price_1h::text, price_24h::text,
           resolution_price::text
         from trade_outcomes where alert_at >= $1`,
        [since],
      );
      const num = (v: string | null) => (v === null ? null : Number(v));
      return result.rows.map((row) => ({
        group: '',
        kind: row.kind,
        side: row.side,
        signalIds: row.signal_ids,
        deliveryTier: row.delivery_tier,
        priceAtAlert: Number(row.price_at_alert),
        price1h: num(row.price_1h),
        price24h: num(row.price_24h),
        resolutionPrice: num(row.resolution_price),
      }));
    },
  };
}

export type TradeOutcomeStore = ReturnType<typeof createTradeOutcomeStore>;
