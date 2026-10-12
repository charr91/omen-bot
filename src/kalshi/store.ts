import type { Pool } from 'pg';
import type { KalshiMarket, KalshiTrade } from './client.js';
import type { BookSnapshot, HourlyVolume, KalshiSignal } from './signals.js';

export const KALSHI_SCHEMA_SQL = [
  `create table if not exists kalshi_markets (
    ticker text primary key,
    event_ticker text not null,
    title text not null,
    status text not null,
    result text not null default '',
    close_time timestamptz,
    volume_24h numeric not null default 0,
    yes_bid numeric,
    yes_ask numeric,
    last_price numeric,
    updated_at timestamptz not null default now()
  );`,
  `create table if not exists kalshi_hourly_volume (
    ticker text not null,
    hour timestamptz not null,
    notional_usd numeric not null default 0,
    yes_notional_usd numeric not null default 0,
    trades integer not null default 0,
    primary key (ticker, hour)
  );`,
  'create index if not exists idx_kalshi_hourly_volume_hour on kalshi_hourly_volume (hour);',
  `create table if not exists kalshi_trades (
    trade_id text primary key,
    ticker text not null,
    created_at timestamptz not null,
    yes_price numeric not null,
    contracts numeric not null,
    notional_usd numeric not null,
    taker_side text not null,
    is_block_trade boolean not null
  );`,
  'create index if not exists idx_kalshi_trades_ticker_time on kalshi_trades (ticker, created_at);',
  `create table if not exists kalshi_book_snapshots (
    ticker text not null,
    at timestamptz not null,
    yes_bid numeric,
    yes_ask numeric,
    bid_size numeric not null,
    ask_size numeric not null,
    primary key (ticker, at)
  );`,
  `create table if not exists kalshi_signals (
    id text primary key,
    signal_id text not null,
    ticker text not null,
    side text not null,
    at timestamptz not null,
    yes_price numeric not null,
    size_usd numeric,
    trade_id text,
    evidence jsonb not null,
    created_at timestamptz not null default now()
  );`,
  'create index if not exists idx_kalshi_signals_at on kalshi_signals (at);',
  `create table if not exists venue_market_map (
    polymarket_market_id text not null,
    kalshi_ticker text not null,
    invert boolean not null default false,
    note text,
    created_at timestamptz not null default now(),
    primary key (polymarket_market_id, kalshi_ticker)
  );`,
];

export interface VenueMapping {
  polymarketMarketId: string;
  kalshiTicker: string;
  invert: boolean;
  note: string | null;
}

/** Signal ids are deterministic so the same event never inserts twice (trade id, ticker-hour, or cooldown bucket). */
export function kalshiSignalKey(signal: KalshiSignal, cooldownMs: number): string {
  if (signal.tradeId) return `${signal.signalId}:${signal.tradeId}`;
  return `${signal.signalId}:${signal.ticker}:${Math.floor(signal.at.getTime() / cooldownMs)}`;
}

export function createKalshiStore(pool: Pick<Pool, 'query'>) {
  return {
    async addHourlyVolume(trades: KalshiTrade[]): Promise<void> {
      const buckets = new Map<string, { ticker: string; hour: Date; notional: number; yes: number; trades: number }>();
      for (const trade of trades) {
        const hour = new Date(Math.floor(trade.createdAt.getTime() / 3_600_000) * 3_600_000);
        const key = `${trade.ticker}|${hour.toISOString()}`;
        const bucket = buckets.get(key) ?? { ticker: trade.ticker, hour, notional: 0, yes: 0, trades: 0 };
        bucket.notional += trade.notionalUsd;
        if (trade.takerSide === 'yes') bucket.yes += trade.notionalUsd;
        bucket.trades += 1;
        buckets.set(key, bucket);
      }
      const rows = [...buckets.values()];
      if (rows.length === 0) return;
      await pool.query(
        `insert into kalshi_hourly_volume (ticker, hour, notional_usd, yes_notional_usd, trades)
         select * from unnest($1::text[], $2::timestamptz[], $3::numeric[], $4::numeric[], $5::int[])
         on conflict (ticker, hour) do update set
           notional_usd = kalshi_hourly_volume.notional_usd + excluded.notional_usd,
           yes_notional_usd = kalshi_hourly_volume.yes_notional_usd + excluded.yes_notional_usd,
           trades = kalshi_hourly_volume.trades + excluded.trades`,
        [rows.map((r) => r.ticker), rows.map((r) => r.hour), rows.map((r) => r.notional), rows.map((r) => r.yes), rows.map((r) => r.trades)],
      );
    },

    async insertTrades(trades: KalshiTrade[]): Promise<void> {
      if (trades.length === 0) return;
      await pool.query(
        `insert into kalshi_trades (trade_id, ticker, created_at, yes_price, contracts, notional_usd, taker_side, is_block_trade)
         select * from unnest($1::text[], $2::text[], $3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[], $8::boolean[])
         on conflict (trade_id) do nothing`,
        [
          trades.map((t) => t.tradeId),
          trades.map((t) => t.ticker),
          trades.map((t) => t.createdAt),
          trades.map((t) => t.yesPrice),
          trades.map((t) => t.count),
          trades.map((t) => t.notionalUsd),
          trades.map((t) => t.takerSide),
          trades.map((t) => t.isBlockTrade),
        ],
      );
    },

    async upsertMarkets(markets: KalshiMarket[]): Promise<void> {
      for (const m of markets) {
        await pool.query(
          `insert into kalshi_markets (ticker, event_ticker, title, status, result, close_time, volume_24h, yes_bid, yes_ask, last_price, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           on conflict (ticker) do update set event_ticker = excluded.event_ticker, title = excluded.title,
             status = excluded.status, result = excluded.result, close_time = excluded.close_time,
             volume_24h = excluded.volume_24h, yes_bid = excluded.yes_bid, yes_ask = excluded.yes_ask,
             last_price = excluded.last_price, updated_at = now()`,
          [m.ticker, m.eventTicker, m.title, m.status, m.result, m.closeTime, m.volume24h, m.yesBid, m.yesAsk, m.lastPrice],
        );
      }
    },

    async listUnknownActiveTickers(since: Date, minNotional: number, limit: number): Promise<string[]> {
      const result = await pool.query<{ ticker: string }>(
        `select v.ticker from kalshi_hourly_volume v
         left join kalshi_markets m on m.ticker = v.ticker
         where v.hour >= $1 and m.ticker is null
         group by v.ticker having sum(v.notional_usd) >= $2
         order by sum(v.notional_usd) desc limit $3`,
        [since, minNotional, limit],
      );
      return result.rows.map((r) => r.ticker);
    },

    async listHotTickers(hour: Date, minNotional: number, limit: number): Promise<Array<{ ticker: string } & HourlyVolume>> {
      const result = await pool.query<{ ticker: string; hour: Date; notional_usd: string; yes_notional_usd: string }>(
        `select ticker, hour, notional_usd::text, yes_notional_usd::text from kalshi_hourly_volume
         where hour = $1 and notional_usd >= $2 order by notional_usd desc limit $3`,
        [hour, minNotional, limit],
      );
      return result.rows.map((r) => ({
        ticker: r.ticker,
        hour: r.hour,
        notionalUsd: Number(r.notional_usd),
        yesNotionalUsd: Number(r.yes_notional_usd),
      }));
    },

    async listHourlyHistory(ticker: string, from: Date, to: Date): Promise<HourlyVolume[]> {
      const result = await pool.query<{ hour: Date; notional_usd: string; yes_notional_usd: string }>(
        `select hour, notional_usd::text, yes_notional_usd::text from kalshi_hourly_volume
         where ticker = $1 and hour >= $2 and hour < $3`,
        [ticker, from, to],
      );
      return result.rows.map((r) => ({ hour: r.hour, notionalUsd: Number(r.notional_usd), yesNotionalUsd: Number(r.yes_notional_usd) }));
    },

    async getMarket(ticker: string): Promise<{ eventTicker: string; yesBid: number | null; yesAsk: number | null; lastPrice: number | null } | null> {
      const result = await pool.query<{ event_ticker: string; yes_bid: string | null; yes_ask: string | null; last_price: string | null }>(
        `select event_ticker, yes_bid::text, yes_ask::text, last_price::text from kalshi_markets where ticker = $1`,
        [ticker],
      );
      const row = result.rows[0];
      const n = (v: string | null) => (v === null ? null : Number(v));
      return row ? { eventTicker: row.event_ticker, yesBid: n(row.yes_bid), yesAsk: n(row.yes_ask), lastPrice: n(row.last_price) } : null;
    },

    async insertSnapshots(snapshots: Array<BookSnapshot & { ticker: string }>): Promise<void> {
      for (const s of snapshots) {
        await pool.query(
          `insert into kalshi_book_snapshots (ticker, at, yes_bid, yes_ask, bid_size, ask_size) values ($1,$2,$3,$4,$5,$6)
           on conflict do nothing`,
          [s.ticker, s.at, s.yesBid, s.yesAsk, s.bidSize, s.askSize],
        );
      }
    },

    async listSnapshots(ticker: string, since: Date): Promise<BookSnapshot[]> {
      const result = await pool.query<{ at: Date; yes_bid: string | null; yes_ask: string | null; bid_size: string; ask_size: string }>(
        `select at, yes_bid::text, yes_ask::text, bid_size::text, ask_size::text from kalshi_book_snapshots
         where ticker = $1 and at >= $2 order by at`,
        [ticker, since],
      );
      const n = (v: string | null) => (v === null ? null : Number(v));
      return result.rows.map((r) => ({ at: r.at, yesBid: n(r.yes_bid), yesAsk: n(r.yes_ask), bidSize: Number(r.bid_size), askSize: Number(r.ask_size) }));
    },

    /** Returns true when the signal was new. */
    async insertSignal(signal: KalshiSignal, cooldownMs: number): Promise<boolean> {
      const result = await pool.query(
        `insert into kalshi_signals (id, signal_id, ticker, side, at, yes_price, size_usd, trade_id, evidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing`,
        [
          kalshiSignalKey(signal, cooldownMs),
          signal.signalId,
          signal.ticker,
          signal.side,
          signal.at,
          signal.yesPrice,
          signal.sizeUsd,
          signal.tradeId,
          JSON.stringify(signal.evidence),
        ],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async listMappings(): Promise<VenueMapping[]> {
      const result = await pool.query<{ polymarket_market_id: string; kalshi_ticker: string; invert: boolean; note: string | null }>(
        `select polymarket_market_id, kalshi_ticker, invert, note from venue_market_map order by created_at`,
      );
      return result.rows.map((r) => ({ polymarketMarketId: r.polymarket_market_id, kalshiTicker: r.kalshi_ticker, invert: r.invert, note: r.note }));
    },

    async addMapping(mapping: VenueMapping): Promise<void> {
      await pool.query(
        `insert into venue_market_map (polymarket_market_id, kalshi_ticker, invert, note) values ($1,$2,$3,$4)
         on conflict (polymarket_market_id, kalshi_ticker) do update set invert = excluded.invert, note = excluded.note`,
        [mapping.polymarketMarketId, mapping.kalshiTicker, mapping.invert, mapping.note],
      );
    },

    async removeMapping(polymarketMarketId: string, kalshiTicker: string): Promise<boolean> {
      const result = await pool.query(`delete from venue_market_map where polymarket_market_id = $1 and kalshi_ticker = $2`, [
        polymarketMarketId,
        kalshiTicker,
      ]);
      return (result.rowCount ?? 0) > 0;
    },

    /** Latest Polymarket YES price for a market from ingested fills (YES fills directly, NO fills as 1 - price). */
    async getPolymarketYesPrice(marketId: string, since: Date): Promise<number | null> {
      const result = await pool.query<{ yes: string }>(
        `select (case when outcome = 'YES' then price else 1 - price end)::text as yes from fills
         where market_id = $1 and timestamp >= $2 order by timestamp desc limit 1`,
        [marketId, since],
      );
      const value = Number(result.rows[0]?.yes ?? Number.NaN);
      return Number.isFinite(value) ? value : null;
    },

    async countRecentPolymarketSignals(marketId: string, since: Date): Promise<number> {
      const result = await pool.query<{ n: string }>(
        `select count(*)::text as n from signal_events where market_id = $1 and created_at >= $2`,
        [marketId, since],
      );
      return Number(result.rows[0]?.n ?? 0);
    },

    async prune(now: Date): Promise<void> {
      await pool.query(`delete from kalshi_book_snapshots where at < $1`, [new Date(now.getTime() - 2 * 86_400_000)]);
      await pool.query(`delete from kalshi_hourly_volume where hour < $1`, [new Date(now.getTime() - 30 * 86_400_000)]);
      await pool.query(`delete from kalshi_trades where created_at < $1`, [new Date(now.getTime() - 30 * 86_400_000)]);
    },
  };
}

export type KalshiStore = ReturnType<typeof createKalshiStore>;
