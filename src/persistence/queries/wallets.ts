import type { Pool } from 'pg';
import type { WalletProfile } from '../../types/wallet.js';

interface WalletAggregateRow {
  total_fills: string;
  total_markets: string;
  total_volume_usd: string;
}

export interface WalletAggregateStats {
  totalFills: number;
  totalMarkets: number;
  totalVolumeUsd: string;
}

export interface WalletStore {
  upsertWalletStub(address: string, seenAt: Date): Promise<void>;
  getAggregateStats(address: string): Promise<WalletAggregateStats>;
  isWhitelisted(address: string): Promise<boolean>;
  upsertLiveProfile(profile: WalletProfile): Promise<void>;
}

export function createWalletStore(pool: Pick<Pool, 'query'>): WalletStore {
  return {
    async upsertWalletStub(address: string, seenAt: Date): Promise<void> {
      await pool.query(
        `
          insert into wallets (
            address,
            first_seen_at,
            last_active_at
          )
          values ($1, $2, $2)
          on conflict (address) do update
          set
            first_seen_at = least(wallets.first_seen_at, excluded.first_seen_at),
            last_active_at = greatest(wallets.last_active_at, excluded.last_active_at),
            updated_at = now()
        `,
        [address, seenAt],
      );
    },

    async getAggregateStats(address: string): Promise<WalletAggregateStats> {
      const result = await pool.query<WalletAggregateRow>(
        `
          select
            count(*)::text as total_fills,
            count(distinct market_id)::text as total_markets,
            coalesce(sum(size_usd), 0)::text as total_volume_usd
          from fills
          where wallet_address = $1
        `,
        [address],
      );

      const row = result.rows[0];
      return {
        totalFills: Number(row?.total_fills ?? '0'),
        totalMarkets: Number(row?.total_markets ?? '0'),
        totalVolumeUsd: row?.total_volume_usd ?? '0.000000',
      };
    },

    async isWhitelisted(address: string): Promise<boolean> {
      const result = await pool.query<{ exists: boolean }>(
        `
          select exists (
            select 1
            from whale_whitelist
            where wallet_address = $1
          ) as exists
        `,
        [address],
      );

      return result.rows[0]?.exists ?? false;
    },

    async upsertLiveProfile(profile: WalletProfile): Promise<void> {
      await pool.query(
        `
          insert into wallets (
            address,
            age_seconds,
            total_transactions,
            is_contract,
            controller_address,
            first_seen_at,
            last_active_at,
            total_markets,
            total_fills,
            total_volume_usd,
            live_suspicion_score,
            live_tier,
            is_whitelisted,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
          on conflict (address) do update
          set
            age_seconds = excluded.age_seconds,
            total_transactions = excluded.total_transactions,
            is_contract = excluded.is_contract,
            controller_address = excluded.controller_address,
            first_seen_at = least(wallets.first_seen_at, excluded.first_seen_at),
            last_active_at = greatest(wallets.last_active_at, excluded.last_active_at),
            total_markets = excluded.total_markets,
            total_fills = excluded.total_fills,
            total_volume_usd = excluded.total_volume_usd,
            live_suspicion_score = greatest(wallets.live_suspicion_score, excluded.live_suspicion_score),
            live_tier = case
              when excluded.live_suspicion_score >= wallets.live_suspicion_score then excluded.live_tier
              else wallets.live_tier
            end,
            is_whitelisted = excluded.is_whitelisted,
            updated_at = now()
        `,
        [
          profile.address,
          profile.ageSeconds,
          profile.totalTransactions,
          profile.isContract,
          profile.controllerAddress,
          profile.firstSeenAt,
          profile.lastActiveAt,
          profile.totalMarkets,
          profile.totalFills,
          profile.totalVolumeUsd,
          profile.liveSuspicionScore,
          profile.liveTier,
          profile.isWhitelisted,
        ],
      );
    },
  };
}
