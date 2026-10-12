import type { Pool } from 'pg';
import { canonicalizeEvmAddress } from '../evm/address.js';

/** A funding-graph rebuild is only worth Alchemy CU when the wallet recently made a signal-eligible fill. */
export const COLD_JOB_RELEVANCE_WINDOW_MS = 24 * 60 * 60_000;
export const FUNDING_GRAPH_FRESH_MS = 24 * 60 * 60_000;

export type ColdJobSkipReason = 'graph-fresh' | 'no-recent-eligible-fill' | 'daily-budget';

export interface ColdJobRelevanceInput {
  fundingGraphBuiltAt: Date | null;
  maxRecentFillUsd: number;
  minFillUsd: number;
  now: Date;
  /** True when the wallet has any signal event and rebuild_if_signaled is on. */
  signaled?: boolean;
}

/** Hot-path enqueue rule: rebuild only for large fills or wallets that already triggered a signal. */
export function shouldRequestRebuild(fillSizeUsd: number, rebuildMinFillUsd: number, signaled: boolean): boolean {
  return signaled || !Number.isFinite(fillSizeUsd) || fillSizeUsd >= rebuildMinFillUsd;
}

export function decideColdJobSkip(input: ColdJobRelevanceInput): ColdJobSkipReason | null {
  if (
    input.fundingGraphBuiltAt !== null &&
    input.now.getTime() - input.fundingGraphBuiltAt.getTime() < FUNDING_GRAPH_FRESH_MS
  ) {
    return 'graph-fresh';
  }

  if (!input.signaled && !(input.maxRecentFillUsd >= input.minFillUsd)) {
    return 'no-recent-eligible-fill';
  }

  return null;
}

export interface ColdJobRelevanceStore {
  getMaxRecentFillUsd(walletAddress: string, since: Date): Promise<number>;
  hasSignalEvents?(walletAddress: string): Promise<boolean>;
}

export function createColdJobRelevanceStore(pool: Pick<Pool, 'query'>): Required<ColdJobRelevanceStore> {
  return {
    async getMaxRecentFillUsd(walletAddress: string, since: Date): Promise<number> {
      const result = await pool.query<{ max_usd: string | null }>(
        `select max(size_usd)::text as max_usd from fills where lower(wallet_address) = $1 and timestamp >= $2`,
        [canonicalizeEvmAddress(walletAddress), since],
      );
      return Number(result.rows[0]?.max_usd ?? 0);
    },

    async hasSignalEvents(walletAddress: string): Promise<boolean> {
      const result = await pool.query(`select 1 from signal_events where lower(wallet_address) = $1 limit 1`, [
        canonicalizeEvmAddress(walletAddress),
      ]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}
