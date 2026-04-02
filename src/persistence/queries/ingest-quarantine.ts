import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { JsonObject } from '../../phase0/types.js';

export interface IngestQuarantineEntry {
  id: string;
  source: string;
  rawPayload: JsonObject;
  failureReason: string;
  createdAt: Date;
}

export interface IngestQuarantineStore {
  recordFailure(input: {
    source: string;
    rawPayload: JsonObject;
    failureReason: string;
  }): Promise<IngestQuarantineEntry>;
  listRecent(limit: number): Promise<IngestQuarantineEntry[]>;
  getById(id: string): Promise<IngestQuarantineEntry | null>;
}

export function createIngestQuarantineStore(pool: Pick<Pool, 'query'>): IngestQuarantineStore {
  return {
    async recordFailure(input: {
      source: string;
      rawPayload: JsonObject;
      failureReason: string;
    }): Promise<IngestQuarantineEntry> {
      const result = await pool.query<{
        id: string;
        source: string;
        raw_payload: JsonObject;
        failure_reason: string;
        created_at: Date;
      }>(
        `
          insert into ingest_quarantine (
            id,
            source,
            raw_payload,
            failure_reason,
            error_reason,
            created_at
          )
          values ($1, $2, $3, $4, $4, now())
          returning
            id,
            source,
            raw_payload,
            coalesce(failure_reason, error_reason) as failure_reason,
            created_at
        `,
        [randomUUID(), input.source, JSON.stringify(input.rawPayload), input.failureReason],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Failed to quarantine malformed payload from ${input.source}`);
      }

      return mapQuarantineRow(row);
    },

    async listRecent(limit: number): Promise<IngestQuarantineEntry[]> {
      const result = await pool.query<{
        id: string;
        source: string;
        raw_payload: JsonObject;
        failure_reason: string;
        created_at: Date;
      }>(
        `
          select
            id,
            source,
            raw_payload,
            coalesce(failure_reason, error_reason) as failure_reason,
            created_at
          from ingest_quarantine
          order by created_at desc
          limit $1
        `,
        [limit],
      );

      return result.rows.map(mapQuarantineRow);
    },

    async getById(id: string): Promise<IngestQuarantineEntry | null> {
      const result = await pool.query<{
        id: string;
        source: string;
        raw_payload: JsonObject;
        failure_reason: string;
        created_at: Date;
      }>(
        `
          select
            id,
            source,
            raw_payload,
            coalesce(failure_reason, error_reason) as failure_reason,
            created_at
          from ingest_quarantine
          where id = $1
        `,
        [id],
      );

      return result.rows[0] ? mapQuarantineRow(result.rows[0]) : null;
    },
  };
}

function mapQuarantineRow(row: {
  id: string;
  source: string;
  raw_payload: JsonObject;
  failure_reason: string;
  created_at: Date;
}): IngestQuarantineEntry {
  return {
    id: row.id,
    source: row.source,
    rawPayload: row.raw_payload,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}
