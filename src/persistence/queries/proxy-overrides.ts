import type { Pool } from 'pg';
import { canonicalizeEvmAddress } from '../../evm/address.js';

export interface ProxyOverrideEntry {
  contractAddress: string;
  controllerAddress: string;
  reason: string;
  addedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProxyOverrideStore {
  listEntries(): Promise<ProxyOverrideEntry[]>;
  getOverride(address: string): Promise<ProxyOverrideEntry | null>;
  upsertOverride(input: {
    contractAddress: string;
    controllerAddress: string;
    reason: string;
    addedBy: string;
  }): Promise<ProxyOverrideEntry>;
  clearOverride(address: string): Promise<ProxyOverrideEntry | null>;
}

export function createProxyOverrideStore(pool: Pick<Pool, 'query'>): ProxyOverrideStore {
  return {
    async listEntries(): Promise<ProxyOverrideEntry[]> {
      const result = await pool.query<{
        contract_address: string;
        controller_address: string;
        reason: string;
        added_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          select
            contract_address,
            controller_address,
            reason,
            added_by,
            created_at,
            updated_at
          from proxy_overrides
          order by lower(contract_address) asc
        `,
      );

      return result.rows.map(mapProxyOverrideRow);
    },

    async getOverride(address: string): Promise<ProxyOverrideEntry | null> {
      const result = await pool.query<{
        contract_address: string;
        controller_address: string;
        reason: string;
        added_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          select
            contract_address,
            controller_address,
            reason,
            added_by,
            created_at,
            updated_at
          from proxy_overrides
          where lower(contract_address) = $1
        `,
        [canonicalizeEvmAddress(address)],
      );

      return result.rows[0] ? mapProxyOverrideRow(result.rows[0]) : null;
    },

    async upsertOverride(input: {
      contractAddress: string;
      controllerAddress: string;
      reason: string;
      addedBy: string;
    }): Promise<ProxyOverrideEntry> {
      const result = await pool.query<{
        contract_address: string;
        controller_address: string;
        reason: string;
        added_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          insert into proxy_overrides (
            contract_address,
            controller_address,
            reason,
            added_by,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, now(), now())
          on conflict (contract_address) do update
          set
            controller_address = excluded.controller_address,
            reason = excluded.reason,
            added_by = excluded.added_by,
            updated_at = now()
          returning
            contract_address,
            controller_address,
            reason,
            added_by,
            created_at,
            updated_at
        `,
        [
          canonicalizeEvmAddress(input.contractAddress),
          canonicalizeEvmAddress(input.controllerAddress),
          input.reason,
          input.addedBy,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Failed to upsert proxy override for ${input.contractAddress}`);
      }

      return mapProxyOverrideRow(row);
    },

    async clearOverride(address: string): Promise<ProxyOverrideEntry | null> {
      const result = await pool.query<{
        contract_address: string;
        controller_address: string;
        reason: string;
        added_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          delete from proxy_overrides
          where lower(contract_address) = $1
          returning
            contract_address,
            controller_address,
            reason,
            added_by,
            created_at,
            updated_at
        `,
        [canonicalizeEvmAddress(address)],
      );

      return result.rows[0] ? mapProxyOverrideRow(result.rows[0]) : null;
    },
  };
}

function mapProxyOverrideRow(row: {
  contract_address: string;
  controller_address: string;
  reason: string;
  added_by: string;
  created_at: Date;
  updated_at: Date;
}): ProxyOverrideEntry {
  return {
    contractAddress: canonicalizeEvmAddress(row.contract_address),
    controllerAddress: canonicalizeEvmAddress(row.controller_address),
    reason: row.reason,
    addedBy: row.added_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
