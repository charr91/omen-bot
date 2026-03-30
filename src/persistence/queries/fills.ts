import type { Pool } from 'pg';
import type { FillRecord, NewFill } from '../../types/fill.js';

interface FillRow {
  id: string;
  market_id: string;
  token_id: string;
  wallet_address: string;
  side: FillRecord['side'];
  outcome: FillRecord['outcome'];
  price: string;
  shares: string;
  size_usd: string;
  tx_hash: string;
  order_type: FillRecord['orderType'];
  timestamp: Date;
  analyzed: boolean;
  created_at: Date;
}

export interface FillStore {
  getLatestFillTimestamp(): Promise<Date | null>;
  insertFill(fill: NewFill): Promise<boolean>;
  listUnanalyzedFills(limit: number): Promise<FillRecord[]>;
  markFillAnalyzed(fillId: string): Promise<void>;
}

export function createFillStore(pool: Pick<Pool, 'query'>): FillStore {
  return {
    async getLatestFillTimestamp(): Promise<Date | null> {
      const result = await pool.query<{ timestamp: Date | null }>('select max(timestamp) as timestamp from fills');
      return result.rows[0]?.timestamp ?? null;
    },

    async insertFill(fill: NewFill): Promise<boolean> {
      const result = await pool.query<{ id: string }>(
        `
          insert into fills (
            id,
            market_id,
            token_id,
            wallet_address,
            side,
            outcome,
            price,
            shares,
            size_usd,
            tx_hash,
            order_type,
            timestamp,
            analyzed
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false)
          on conflict (tx_hash, token_id) do nothing
          returning id
        `,
        [
          fill.id,
          fill.marketId,
          fill.tokenId,
          fill.walletAddress,
          fill.side,
          fill.outcome,
          fill.price,
          fill.shares,
          fill.sizeUsd,
          fill.txHash,
          fill.orderType,
          fill.timestamp,
        ],
      );

      return result.rowCount === 1;
    },

    async listUnanalyzedFills(limit: number): Promise<FillRecord[]> {
      const result = await pool.query<FillRow>(
        `
          select
            id,
            market_id,
            token_id,
            wallet_address,
            side,
            outcome,
            price::text as price,
            shares::text as shares,
            size_usd::text as size_usd,
            tx_hash,
            order_type,
            timestamp,
            analyzed,
            created_at
          from fills
          where analyzed = false
          order by timestamp asc
          limit $1
        `,
        [limit],
      );

      return result.rows.map(mapFillRow);
    },

    async markFillAnalyzed(fillId: string): Promise<void> {
      await pool.query('update fills set analyzed = true where id = $1', [fillId]);
    },
  };
}

function mapFillRow(row: FillRow): FillRecord {
  return {
    id: row.id,
    marketId: row.market_id,
    tokenId: row.token_id,
    walletAddress: row.wallet_address,
    side: row.side,
    outcome: row.outcome,
    price: row.price,
    shares: row.shares,
    sizeUsd: row.size_usd,
    txHash: row.tx_hash,
    orderType: row.order_type,
    timestamp: row.timestamp,
    analyzed: row.analyzed,
    createdAt: row.created_at,
  };
}
