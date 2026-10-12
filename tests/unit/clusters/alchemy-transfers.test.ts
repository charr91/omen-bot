import { describe, expect, it } from 'vitest';
import { AlchemyFundingGraphBuilder } from '../../../src/clusters/alchemy-transfers.js';
import type { AppConfig } from '../../../src/config/schema.js';

function makeConfig(): Pick<AppConfig, 'detection'> {
  return {
    detection: {
      freshWallet: {
        criticalAgeHours: 24,
        elevatedAgeHours: 72,
        maxTransactions: 10,
      },
      market: {
        nicheMaxVolume: 100_000,
        largePositionMinUsd: 1_000,
        largePositionVolumePct: 0.02,
      },
      nicheMarketEntry: {
        maxMarketVolumeUsd: 100_000,
        minFillUsd: 1_000,
      },
      convictionSizeMismatch: {
        maxWalletTotalVolumeUsd: 5_000,
        minFillToWalletVolumeRatio: 0.5,
        longshotMaxPrice: 0.3,
        minFillUsd: 250,
      },
      lumpEntry: {
        minFillUsd: 500,
        minLumpRatio: 0.8,
      },
      cluster: {
        minSize: 3,
        minFillUsd: 25,
        fundingMaxDepth: 4,
        fanoutLimit: 5,
        maxRpcCalls: 200,
      },
    },
  };
}

describe('AlchemyFundingGraphBuilder', () => {
  it('truncates gracefully when rate limiting prevents additional RPC calls', async () => {
    const builder = new AlchemyFundingGraphBuilder('alchemy-key', {
      fetchImpl: (() => {
        throw new Error('fetch should not be called when rate limiter denies');
      }) as typeof fetch,
    });
    (builder as unknown as { rateLimiter: { tryAcquire: () => boolean } }).rateLimiter = {
      tryAcquire: () => false,
    };

    await expect(builder.buildGraph('0x0000000000000000000000000000000000000001', makeConfig())).resolves.toEqual({
      edges: [],
      truncated: true,
    });
  });

  it('uses transfer metadata timestamps instead of one eth_getBlockByNumber per edge', async () => {
    const methods: string[] = [];
    const bodies: Array<{ params: Array<{ withMetadata?: boolean; toAddress?: string }> }> = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: Array<{ withMetadata?: boolean; toAddress?: string }> };
      methods.push(body.method);
      bodies.push(body);
      const isRoot = body.params[0]?.toAddress === '0x0000000000000000000000000000000000000001';
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            transfers: isRoot
              ? [{ blockNum: '0x10', from: '0xfunder', hash: '0xh', asset: 'USDC', value: 50, metadata: { blockTimestamp: '2026-10-01T00:00:00.000Z' } }]
              : [],
          },
        }),
      );
    }) as typeof fetch;
    const builder = new AlchemyFundingGraphBuilder('alchemy-key', { fetchImpl });
    const result = await builder.buildGraph('0x0000000000000000000000000000000000000001', makeConfig());

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.timestamp).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(methods).not.toContain('eth_getBlockByNumber');
    expect(bodies[0]!.params[0]!.withMetadata).toBe(true);
  });
});

