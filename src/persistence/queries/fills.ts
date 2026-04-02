import type { Pool } from 'pg';
import { canonicalizeEvmAddress } from '../../evm/address.js';
import { stableObservationKey } from '../../phase0/json.js';
import type { FillRecord, FillSide, NewFill } from '../../types/fill.js';

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

interface LatestFillCursorRow {
  timestamp: Date;
  tx_hash: string | null;
  token_id: string | null;
}

interface FillRuntimeSummaryRow {
  unanalyzed_count: string;
  newest_fill_timestamp: Date | null;
}

export interface FillCursor {
  timestamp: Date;
  seenFillKeysAtTimestamp: string[];
}

export interface FillRuntimeSummary {
  unanalyzedFillCount: number;
  newestFillTimestamp: Date | null;
}

export interface FillStore {
  getLatestFillCursor(): Promise<FillCursor | null>;
  insertFill(fill: NewFill): Promise<boolean>;
  listUnanalyzedFills(limit: number): Promise<FillRecord[]>;
  listMarketFillsByWallets(
    marketId: string,
    walletAddresses: string[],
    windowStart: Date,
    boundary: { fillTimestamp: Date; fillId: string },
    options?: { side?: FillSide },
  ): Promise<FillRecord[]>;
  markFillAnalyzed(fillId: string): Promise<void>;
  getRuntimeSummary(): Promise<FillRuntimeSummary>;
  countDistinctWalletsForMarketSideWindow(
    marketId: string,
    side: FillRecord['side'],
    walletAddresses: string[],
    since: Date,
    until: Date,
  ): Promise<number>;
}

export function createFillStore(pool: Pick<Pool, 'query'>): FillStore {
  return {
    async getLatestFillCursor(): Promise<FillCursor | null> {
      const result = await pool.query<LatestFillCursorRow>(
        `
          select latest.timestamp, fills.tx_hash, fills.token_id
          from (select max(timestamp) as timestamp from fills) latest
          left join fills on fills.timestamp = latest.timestamp
          where latest.timestamp is not null
        `,
      );

      const timestamp = result.rows[0]?.timestamp ?? null;
      if (!timestamp) {
        return null;
      }

      const seenFillKeysAtTimestamp = [
        ...new Set(
          result.rows.flatMap((row) =>
            row.tx_hash && row.token_id ? [stableObservationKey([row.tx_hash, row.token_id])] : [],
          ),
        ),
      ];

      return {
        timestamp,
        seenFillKeysAtTimestamp,
      };
    },

    async insertFill(fill: NewFill): Promise<boolean> {
      const walletAddress = canonicalizeEvmAddress(fill.walletAddress);
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
          walletAddress,
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
          order by timestamp asc, id asc
          limit $1
        `,
        [limit],
      );

      return result.rows.map(mapFillRow);
    },

    async listMarketFillsByWallets(
      marketId: string,
      walletAddresses: string[],
      windowStart: Date,
      boundary: { fillTimestamp: Date; fillId: string },
      options: { side?: FillSide } = {},
    ): Promise<FillRecord[]> {
      if (walletAddresses.length === 0) {
        return [];
      }

      const canonicalWalletAddresses = [
        ...new Set(walletAddresses.map((walletAddress) => canonicalizeEvmAddress(walletAddress))),
      ];
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
          where market_id = $1
            and lower(wallet_address) = any($2::text[])
            and timestamp >= $3
            and ($6::text is null or side = $6)
            and (
              timestamp < $4
              or (timestamp = $4 and id <= $5)
            )
          order by timestamp asc, id asc
        `,
        [marketId, canonicalWalletAddresses, windowStart, boundary.fillTimestamp, boundary.fillId, options.side ?? null],
      );

      return result.rows.map(mapFillRow);
    },

    async markFillAnalyzed(fillId: string): Promise<void> {
      await pool.query('update fills set analyzed = true where id = $1', [fillId]);
    },

    async getRuntimeSummary(): Promise<FillRuntimeSummary> {
      const result = await pool.query<FillRuntimeSummaryRow>(
        `
          select
            count(*) filter (where analyzed = false)::text as unanalyzed_count,
            max(timestamp) as newest_fill_timestamp
          from fills
        `,
      );

      return {
        unanalyzedFillCount: Number(result.rows[0]?.unanalyzed_count ?? '0'),
        newestFillTimestamp: result.rows[0]?.newest_fill_timestamp ?? null,
      };
    },

    async countDistinctWalletsForMarketSideWindow(
      marketId: string,
      side: FillRecord['side'],
      walletAddresses: string[],
      since: Date,
      until: Date,
    ): Promise<number> {
      const canonicalWalletAddresses = [...new Set(walletAddresses.map((address) => canonicalizeEvmAddress(address)))];
      if (canonicalWalletAddresses.length === 0) {
        return 0;
      }

      const result = await pool.query<{ count: string }>(
        `
          select count(distinct lower(wallet_address))::text as count
          from fills
          where market_id = $1
            and side = $2
            and lower(wallet_address) = any($3::text[])
            and timestamp >= $4
            and timestamp <= $5
        `,
        [marketId, side, canonicalWalletAddresses, since, until],
      );

      return Number(result.rows[0]?.count ?? '0');
    },
  };
}

function mapFillRow(row: FillRow): FillRecord {
  return {
    id: row.id,
    marketId: row.market_id,
    tokenId: row.token_id,
    walletAddress: canonicalizeEvmAddress(row.wallet_address),
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
