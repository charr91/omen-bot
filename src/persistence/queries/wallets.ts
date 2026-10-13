import type { Pool } from 'pg';
import { canonicalizeEvmAddress, canonicalizeOptionalEvmAddress } from '../../evm/address.js';
import type { WalletChainProfile, WalletProfile } from '../../types/wallet.js';

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

export interface WalletSignalContext {
  isWhitelisted: boolean;
  fundingClusterId: string | null;
  fundingGraphBuiltAt: Date | null;
  controllerAddress: string | null;
  /** omen's first-seen fill for the wallet. */
  firstSeenAt?: Date | null;
  /** Earliest depth-1 funding edge into the wallet, and how many there are (age lower bound / activity count). */
  fundingFirstAt?: Date | null;
  fundingInboundCount?: number;
}

export interface FundingClusterAssignment {
  address: string;
  fundingClusterId: string | null;
}

export interface FillBoundary {
  fillId: string;
  fillTimestamp: Date;
}

export interface WalletStore {
  upsertWalletStub(address: string, seenAt: Date): Promise<void>;
  getAggregateStats(address: string, boundary?: FillBoundary): Promise<WalletAggregateStats>;
  getSignalContext(address: string): Promise<WalletSignalContext>;
  isWhitelisted(address: string): Promise<boolean>;
  /** chainKnown=false keeps the stored chain fields (age/txns/contract/controller) instead of overwriting them. */
  upsertLiveProfile(profile: WalletProfile, options?: { chainKnown?: boolean }): Promise<void>;
  /** Persisted effective chain profile (survives restarts), aged forward to `now`. */
  getPersistedChainProfile(address: string, maxAgeMs: number, now?: Date): Promise<WalletChainProfile | null>;
  savePersistedChainProfile(address: string, profile: WalletChainProfile, at?: Date): Promise<void>;
  updateFundingGraphBuiltAt(address: string, builtAt: Date): Promise<void>;
  listFundingClusterMembers(clusterId: string): Promise<string[]>;
  setFundingClusterAssignments(assignments: FundingClusterAssignment[]): Promise<void>;
}

export const PERSISTED_PROFILE_VERSION = 2;

export function createWalletStore(pool: Pick<Pool, 'query'>): WalletStore {
  return {
    async upsertWalletStub(address: string, seenAt: Date): Promise<void> {
      const canonicalAddress = canonicalizeEvmAddress(address);
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
        [canonicalAddress, seenAt],
      );
    },

    async getAggregateStats(address: string, boundary?: FillBoundary): Promise<WalletAggregateStats> {
      const canonicalAddress = canonicalizeEvmAddress(address);
      const result = boundary
        ? await pool.query<WalletAggregateRow>(
            `
              select
                count(*)::text as total_fills,
                count(distinct market_id)::text as total_markets,
                coalesce(sum(size_usd), 0)::text as total_volume_usd
              from fills
              where lower(wallet_address) = $1
                and (
                  timestamp < $2
                  or (timestamp = $2 and id <= $3)
                )
            `,
            [canonicalAddress, boundary.fillTimestamp, boundary.fillId],
          )
        : await pool.query<WalletAggregateRow>(
            `
              select
                count(*)::text as total_fills,
                count(distinct market_id)::text as total_markets,
                coalesce(sum(size_usd), 0)::text as total_volume_usd
              from fills
              where lower(wallet_address) = $1
            `,
            [canonicalAddress],
          );

      const row = result.rows[0];
      return {
        totalFills: Number(row?.total_fills ?? '0'),
        totalMarkets: Number(row?.total_markets ?? '0'),
        totalVolumeUsd: row?.total_volume_usd ?? '0.000000',
      };
    },

    async isWhitelisted(address: string): Promise<boolean> {
      const canonicalAddress = canonicalizeEvmAddress(address);
      const result = await pool.query<{ exists: boolean }>(
        `
          select exists (
            select 1
            from whale_whitelist
            where lower(wallet_address) = $1
          ) as exists
        `,
        [canonicalAddress],
      );

      return result.rows[0]?.exists ?? false;
    },

    async getSignalContext(address: string): Promise<WalletSignalContext> {
      const canonicalAddress = canonicalizeEvmAddress(address);
      const result = await pool.query<{
        is_whitelisted: boolean;
        funding_cluster_id: string | null;
        funding_graph_built_at: Date | null;
        controller_address: string | null;
        first_seen_at: Date | null;
        funding_first_at: Date | null;
        funding_inbound: string | null;
      }>(
        `
          select
            is_whitelisted,
            funding_cluster_id,
            funding_graph_built_at,
            controller_address,
            first_seen_at,
            (select min(e.timestamp) from funding_edges e
              where lower(e.root_wallet) = $1 and lower(e.to_address) = $1) as funding_first_at,
            (select count(*)::text from funding_edges e
              where lower(e.root_wallet) = $1 and lower(e.to_address) = $1) as funding_inbound
          from wallets
          where lower(address) = $1
        `,
        [canonicalAddress],
      );

      const row = result.rows[0];
      return {
        isWhitelisted: row?.is_whitelisted ?? false,
        fundingClusterId: row?.funding_cluster_id ?? null,
        fundingGraphBuiltAt: row?.funding_graph_built_at ?? null,
        controllerAddress: canonicalizeOptionalEvmAddress(row?.controller_address ?? null),
        firstSeenAt: row?.first_seen_at ?? null,
        fundingFirstAt: row?.funding_first_at ?? null,
        fundingInboundCount: Number(row?.funding_inbound ?? 0),
      };
    },

    async getPersistedChainProfile(address: string, maxAgeMs: number, now = new Date()): Promise<WalletChainProfile | null> {
      const result = await pool.query<{ chain_profile: Record<string, unknown>; chain_profiled_at: Date }>(
        `select chain_profile, chain_profiled_at from wallets
         where address = $1 and chain_profile is not null and chain_profiled_at >= $2`,
        [canonicalizeEvmAddress(address), new Date(now.getTime() - maxAgeMs)],
      );
      const row = result.rows[0];
      if (!row) return null;
      const raw = row.chain_profile;
      // v1 rows could carry "first activity = profiling time" for wallets with no on-chain history; re-profile.
      if (raw.profileVersion !== PERSISTED_PROFILE_VERSION) return null;
      const elapsed = Math.max(0, Math.floor((now.getTime() - row.chain_profiled_at.getTime()) / 1000));
      const ageSeconds = Number(raw.ageSeconds ?? 0);
      const freshnessAgeSeconds = Number(raw.freshnessAgeSeconds ?? 0);
      return {
        ageSeconds: raw.activityAgeKnown ? ageSeconds + elapsed : ageSeconds,
        activityAgeKnown: raw.activityAgeKnown === true,
        totalTransactions: Number(raw.totalTransactions ?? 0),
        isContract: raw.isContract === true,
        controllerAddress: typeof raw.controllerAddress === 'string' ? raw.controllerAddress : null,
        freshnessAgeSeconds: raw.freshnessActivityAgeKnown ? freshnessAgeSeconds + elapsed : freshnessAgeSeconds,
        freshnessActivityAgeKnown: raw.freshnessActivityAgeKnown === true,
        freshnessTotalTransactions: Number(raw.freshnessTotalTransactions ?? 0),
        firstActivityAt: typeof raw.firstActivityAt === 'string' ? new Date(raw.firstActivityAt) : null,
      };
    },

    async savePersistedChainProfile(address: string, profile: WalletChainProfile, at = new Date()): Promise<void> {
      await pool.query(`update wallets set chain_profile = $2::jsonb, chain_profiled_at = $3 where address = $1`, [
        canonicalizeEvmAddress(address),
        JSON.stringify({ ...profile, profileVersion: PERSISTED_PROFILE_VERSION }),
        at,
      ]);
    },

    async upsertLiveProfile(profile: WalletProfile, options: { chainKnown?: boolean } = {}): Promise<void> {
      const chainKnown = options.chainKnown ?? true;
      const canonicalAddress = canonicalizeEvmAddress(profile.address);
      const controllerAddress = canonicalizeOptionalEvmAddress(profile.controllerAddress);
      await pool.query(
        `
          insert into wallets (
            address,
            age_seconds,
            activity_age_known,
            total_transactions,
            is_contract,
            controller_address,
            first_seen_at,
            last_active_at,
            total_markets,
            total_fills,
            total_volume_usd,
            funding_cluster_id,
            live_suspicion_score,
            live_tier,
            is_whitelisted,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
          on conflict (address) do update
          set
            age_seconds = case when $16 then excluded.age_seconds else wallets.age_seconds end,
            activity_age_known = case when $16 then excluded.activity_age_known else wallets.activity_age_known end,
            total_transactions = case when $16 then excluded.total_transactions else wallets.total_transactions end,
            is_contract = case when $16 then excluded.is_contract else wallets.is_contract end,
            controller_address = case when $16 then excluded.controller_address else wallets.controller_address end,
            first_seen_at = least(wallets.first_seen_at, excluded.first_seen_at),
            last_active_at = greatest(wallets.last_active_at, excluded.last_active_at),
            total_markets = excluded.total_markets,
            total_fills = excluded.total_fills,
            total_volume_usd = excluded.total_volume_usd,
            funding_cluster_id = coalesce(excluded.funding_cluster_id, wallets.funding_cluster_id),
            live_suspicion_score = greatest(wallets.live_suspicion_score, excluded.live_suspicion_score),
            live_tier = case
              when excluded.live_suspicion_score >= wallets.live_suspicion_score then excluded.live_tier
              else wallets.live_tier
            end,
            is_whitelisted = excluded.is_whitelisted,
            updated_at = now()
        `,
        [
          canonicalAddress,
          profile.ageSeconds,
          profile.activityAgeKnown,
          profile.totalTransactions,
          profile.isContract,
          controllerAddress,
          profile.firstSeenAt,
          profile.lastActiveAt,
          profile.totalMarkets,
          profile.totalFills,
          profile.totalVolumeUsd,
          profile.fundingClusterId,
          profile.liveSuspicionScore,
          profile.liveTier,
          profile.isWhitelisted,
          chainKnown,
        ],
      );
    },

    async updateFundingGraphBuiltAt(address: string, builtAt: Date): Promise<void> {
      const canonicalAddress = canonicalizeEvmAddress(address);
      await pool.query(
        `
          update wallets
          set
            funding_graph_built_at = $2,
            updated_at = now()
          where lower(address) = $1
        `,
        [canonicalAddress, builtAt],
      );
    },

    async listFundingClusterMembers(clusterId: string): Promise<string[]> {
      const result = await pool.query<{ address: string }>(
        `
          select address
          from wallets
          where funding_cluster_id = $1
          order by address asc
        `,
        [clusterId],
      );

      return result.rows.map((row) => canonicalizeEvmAddress(row.address));
    },

    async setFundingClusterAssignments(assignments: FundingClusterAssignment[]): Promise<void> {
      for (const assignment of assignments) {
        await pool.query(
          `
            update wallets
            set
              funding_cluster_id = $2,
              updated_at = now()
            where lower(address) = $1
          `,
          [canonicalizeEvmAddress(assignment.address), assignment.fundingClusterId],
        );
      }
    },
  };
}
