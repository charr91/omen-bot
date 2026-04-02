import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalizeEvmAddress } from '../../evm/address.js';

export interface FundingEdge {
  id: string;
  rootWallet: string;
  fromAddress: string;
  toAddress: string;
  amountUsd: string;
  asset: string;
  txHash: string;
  timestamp: Date;
  depth: number;
}

export interface NewFundingEdge {
  fromAddress: string;
  toAddress: string;
  amountUsd: string;
  asset: string;
  txHash: string;
  timestamp: Date;
  depth: number;
}

export interface AncestorMembership {
  ancestorAddress: string;
  rootWallet: string;
  minDepth: number;
}

export interface FundingEdgeStore {
  replaceRootEdges(rootWallet: string, edges: NewFundingEdge[], builtAt: Date): Promise<void>;
  listEdgesForRoot(rootWallet: string): Promise<FundingEdge[]>;
  listAncestorMemberships(ancestorAddresses: string[]): Promise<AncestorMembership[]>;
}

export function createFundingEdgeStore(pool: Pick<Pool, 'query'>): FundingEdgeStore {
  return {
    async replaceRootEdges(rootWallet: string, edges: NewFundingEdge[]): Promise<void> {
      const canonicalRootWallet = canonicalizeEvmAddress(rootWallet);
      await pool.query('delete from funding_edges where lower(root_wallet) = $1', [canonicalRootWallet]);

      const uniqueEdges = dedupeEdges(canonicalRootWallet, edges);
      for (const edge of uniqueEdges) {
        await pool.query(
          `
            insert into funding_edges (
              id,
              root_wallet,
              from_address,
              to_address,
              amount_usd,
              asset,
              tx_hash,
              timestamp,
              depth
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            randomUUID(),
            canonicalRootWallet,
            canonicalizeEvmAddress(edge.fromAddress),
            canonicalizeEvmAddress(edge.toAddress),
            edge.amountUsd,
            edge.asset,
            edge.txHash,
            edge.timestamp,
            edge.depth,
          ],
        );
      }
    },

    async listEdgesForRoot(rootWallet: string): Promise<FundingEdge[]> {
      const canonicalRootWallet = canonicalizeEvmAddress(rootWallet);
      const result = await pool.query<{
        id: string;
        root_wallet: string;
        from_address: string;
        to_address: string;
        amount_usd: string;
        asset: string;
        tx_hash: string;
        timestamp: Date;
        depth: number;
      }>(
        `
          select
            id,
            root_wallet,
            from_address,
            to_address,
            amount_usd,
            asset,
            tx_hash,
            timestamp,
            depth
          from funding_edges
          where lower(root_wallet) = $1
          order by depth asc, timestamp desc
        `,
        [canonicalRootWallet],
      );

      return result.rows.map((row) => ({
        id: row.id,
        rootWallet: canonicalizeEvmAddress(row.root_wallet),
        fromAddress: canonicalizeEvmAddress(row.from_address),
        toAddress: canonicalizeEvmAddress(row.to_address),
        amountUsd: row.amount_usd,
        asset: row.asset,
        txHash: row.tx_hash,
        timestamp: row.timestamp,
        depth: row.depth,
      }));
    },

    async listAncestorMemberships(ancestorAddresses: string[]): Promise<AncestorMembership[]> {
      const canonicalAncestorAddresses = [...new Set(ancestorAddresses.map((address) => canonicalizeEvmAddress(address)))];
      if (canonicalAncestorAddresses.length === 0) {
        return [];
      }

      const result = await pool.query<{
        ancestor_address: string;
        root_wallet: string;
        min_depth: number;
      }>(
        `
          select
            from_address as ancestor_address,
            root_wallet,
            min(depth)::int as min_depth
          from funding_edges
          where lower(from_address) = any($1::text[])
          group by from_address, root_wallet
        `,
        [canonicalAncestorAddresses],
      );

      return result.rows.map((row) => ({
        ancestorAddress: canonicalizeEvmAddress(row.ancestor_address),
        rootWallet: canonicalizeEvmAddress(row.root_wallet),
        minDepth: row.min_depth,
      }));
    },
  };
}

function dedupeEdges(rootWallet: string, edges: NewFundingEdge[]): NewFundingEdge[] {
  const uniqueEdges = new Map<string, NewFundingEdge>();

  for (const edge of edges) {
    const key = [
      rootWallet,
      canonicalizeEvmAddress(edge.fromAddress),
      canonicalizeEvmAddress(edge.toAddress),
      edge.txHash,
    ].join(':');

    if (!uniqueEdges.has(key)) {
      uniqueEdges.set(key, edge);
    }
  }

  return [...uniqueEdges.values()];
}
