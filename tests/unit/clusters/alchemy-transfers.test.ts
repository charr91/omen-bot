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
});
