import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { SCORING_VERSION } from '../../config/constants.js';
import type { TriggeredSignal } from '../../types/signal.js';

export interface LiveSignalEventInsert {
  walletAddress: string;
  marketId: string;
  fillId: string;
  signal: TriggeredSignal;
}

export interface SignalEventStore {
  insertLiveSignalEvent(input: LiveSignalEventInsert): Promise<boolean>;
  countRecentLiveSignalEvents(since: Date): Promise<number>;
}

export function createSignalEventStore(pool: Pick<Pool, 'query'>): SignalEventStore {
  return {
    async insertLiveSignalEvent(input: LiveSignalEventInsert): Promise<boolean> {
      const result = await pool.query<{ id: string }>(
        `
          insert into signal_events (
            id,
            wallet_address,
            market_id,
            fill_id,
            signal_id,
            availability,
            score,
            confidence,
            evidence,
            scoring_version
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          on conflict (fill_id, signal_id) do nothing
          returning id
        `,
        [
          randomUUID(),
          input.walletAddress,
          input.marketId,
          input.fillId,
          input.signal.signalId,
          input.signal.availability,
          input.signal.score,
          input.signal.confidence,
          JSON.stringify(input.signal.evidence),
          SCORING_VERSION,
        ],
      );

      return result.rowCount === 1;
    },

    async countRecentLiveSignalEvents(since: Date): Promise<number> {
      const result = await pool.query<{ count: string }>(
        `
          select count(*)::text as count
          from signal_events
          where availability = 'LIVE'
            and created_at >= $1
        `,
        [since],
      );

      return Number(result.rows[0]?.count ?? '0');
    },
  };
}
