import type { Pool } from 'pg';
import { canonicalizeEvmAddress } from '../../evm/address.js';

export interface WhaleWhitelistEntry {
  walletAddress: string;
  label: string;
  reason: string;
  addedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WhaleWhitelistStore {
  listEntries(): Promise<WhaleWhitelistEntry[]>;
  getEntry(address: string): Promise<WhaleWhitelistEntry | null>;
  upsertEntry(input: {
    walletAddress: string;
    label: string;
    reason: string;
    addedBy: string;
  }): Promise<WhaleWhitelistEntry>;
  removeEntry(address: string): Promise<WhaleWhitelistEntry | null>;
}

export function createWhaleWhitelistStore(pool: Pick<Pool, 'query'>): WhaleWhitelistStore {
  return {
    async listEntries(): Promise<WhaleWhitelistEntry[]> {
      const result = await pool.query<{
        wallet_address: string;
        label: string;
        reason: string;
        added_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          select
            wallet_address,
            label,
            reason,
            added_by,
            created_at,
            updated_at
          from whale_whitelist
          order by lower(wallet_address) asc
        `,
      );

      return result.rows.map(mapWhitelistRow);
    },

    async getEntry(address: string): Promise<WhaleWhitelistEntry | null> {
      const result = await pool.query<{
        wallet_address: string;
        label: string;
        reason: string;
        added_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          select
            wallet_address,
            label,
            reason,
            added_by,
            created_at,
            updated_at
          from whale_whitelist
          where lower(wallet_address) = $1
        `,
        [canonicalizeEvmAddress(address)],
      );

      return result.rows[0] ? mapWhitelistRow(result.rows[0]) : null;
    },

    async upsertEntry(input: {
      walletAddress: string;
      label: string;
      reason: string;
      addedBy: string;
    }): Promise<WhaleWhitelistEntry> {
      const result = await pool.query<{
        wallet_address: string;
        label: string;
        reason: string;
        added_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          insert into whale_whitelist (
            wallet_address,
            label,
            reason,
            added_by,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, now(), now())
          on conflict (wallet_address) do update
          set
            label = excluded.label,
            reason = excluded.reason,
            added_by = excluded.added_by,
            updated_at = now()
          returning
            wallet_address,
            label,
            reason,
            added_by,
            created_at,
            updated_at
        `,
        [
          canonicalizeEvmAddress(input.walletAddress),
          input.label,
          input.reason,
          input.addedBy,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Failed to upsert whitelist entry for ${input.walletAddress}`);
      }

      return mapWhitelistRow(row);
    },

    async removeEntry(address: string): Promise<WhaleWhitelistEntry | null> {
      const result = await pool.query<{
        wallet_address: string;
        label: string;
        reason: string;
        added_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          delete from whale_whitelist
          where lower(wallet_address) = $1
          returning
            wallet_address,
            label,
            reason,
            added_by,
            created_at,
            updated_at
        `,
        [canonicalizeEvmAddress(address)],
      );

      return result.rows[0] ? mapWhitelistRow(result.rows[0]) : null;
    },
  };
}

function mapWhitelistRow(row: {
  wallet_address: string;
  label: string;
  reason: string;
  added_by: string;
  created_at: Date;
  updated_at: Date;
}): WhaleWhitelistEntry {
  return {
    walletAddress: canonicalizeEvmAddress(row.wallet_address),
    label: row.label,
    reason: row.reason,
    addedBy: row.added_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
