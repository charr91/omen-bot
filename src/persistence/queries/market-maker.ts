import type { Pool } from 'pg';
import { canonicalizeEvmAddress } from '../../evm/address.js';
import { calculateMarketMakerScore, type MarketMakerActivity } from '../../signals/market-maker.js';

interface ActivityRow {
  wallet: string;
  trade_count: string;
  buy_usd: string;
  sell_usd: string;
  markets: string;
  first_at: Date;
  last_at: Date;
}

function toActivity(row: ActivityRow): MarketMakerActivity {
  return {
    tradeCount: Number(row.trade_count),
    buyVolumeUsd: Number(row.buy_usd),
    sellVolumeUsd: Number(row.sell_usd),
    marketsCount: Number(row.markets),
    firstSeenAt: row.first_at,
    lastSeenAt: row.last_at,
  };
}

const ACTIVITY_SELECT = `
  select lower(wallet_address) as wallet,
    count(*)::text as trade_count,
    coalesce(sum(size_usd) filter (where side = 'BUY'), 0)::text as buy_usd,
    coalesce(sum(size_usd) filter (where side = 'SELL'), 0)::text as sell_usd,
    count(distinct market_id)::text as markets,
    min(timestamp) as first_at,
    max(timestamp) as last_at
  from fills
`;

export function createMarketMakerStore(pool: Pick<Pool, 'query'>) {
  return {
    /** Market-maker score for one wallet from its ingested fills (before `before`, to avoid look-ahead). */
    async getScore(address: string, before?: Date): Promise<number> {
      const result = await pool.query<ActivityRow>(
        `${ACTIVITY_SELECT} where lower(wallet_address) = $1 and ($2::timestamptz is null or timestamp <= $2) group by 1`,
        [canonicalizeEvmAddress(address), before ?? null],
      );
      const row = result.rows[0];
      return row ? calculateMarketMakerScore(toActivity(row)) : 0;
    },

    /** Wallets whose ingested activity scores >= minScore. Only wallets with >= 5 markets or >= 25 fills can qualify. */
    async listLikelyMarketMakers(minScore: number): Promise<string[]> {
      const result = await pool.query<ActivityRow>(
        `${ACTIVITY_SELECT} group by 1 having count(*) >= 25 or count(distinct market_id) >= 5`,
      );
      return result.rows.filter((row) => calculateMarketMakerScore(toActivity(row)) >= minScore).map((row) => row.wallet);
    },
  };
}

export type MarketMakerStore = ReturnType<typeof createMarketMakerStore>;
