import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalizeEvmAddress } from '../../evm/address.js';

export type AuditAction =
  | 'WHITELIST_ADD'
  | 'WHITELIST_REMOVE'
  | 'PROXY_ATTRIBUTE'
  | 'PROXY_OVERRIDE_SET'
  | 'PROXY_OVERRIDE_CLEAR';

export interface AuditLogEntry {
  action: AuditAction;
  targetAddress: string;
  actor: 'auto' | 'manual' | 'system';
  oldValue: unknown;
  newValue: unknown;
  reason: string;
}

export interface AuditLogStore {
  append(entry: AuditLogEntry, createdAt?: Date): Promise<void>;
}

export function createAuditLogStore(pool: Pick<Pool, 'query'>): AuditLogStore {
  return {
    async append(entry: AuditLogEntry, createdAt = new Date()): Promise<void> {
      await pool.query(
        `
          insert into audit_log (
            id,
            action,
            target_address,
            actor,
            old_value,
            new_value,
            reason,
            created_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          randomUUID(),
          entry.action,
          canonicalizeEvmAddress(entry.targetAddress),
          entry.actor,
          entry.oldValue === null ? null : JSON.stringify(entry.oldValue),
          entry.newValue === null ? null : JSON.stringify(entry.newValue),
          entry.reason,
          createdAt,
        ],
      );
    },
  };
}
