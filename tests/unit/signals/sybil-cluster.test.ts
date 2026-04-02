import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { evaluateSybilCluster } from '../../../src/signals/sybil-cluster.js';
import type { FillRecord } from '../../../src/types/fill.js';

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
        minFillUsd: 200,
        elevatedFillUsd: 500,
        fundingMaxDepth: 4,
        fanoutLimit: 5,
        maxRpcCalls: 200,
      },
    },
  };
}

function makeFill(overrides: Partial<FillRecord> = {}): FillRecord {
  return {
    id: 'fill-1',
    marketId: 'market-1',
    tokenId: 'token-1',
    walletAddress: '0xwallet',
    side: 'BUY',
    outcome: 'YES',
    price: '0.200000',
    shares: '6000.000000',
    sizeUsd: '1500.000000',
    txHash: '0xtx-1',
    orderType: 'UNKNOWN',
    timestamp: new Date('2026-03-30T00:10:00.000Z'),
    analyzed: false,
    createdAt: new Date('2026-03-30T00:10:00.000Z'),
    ...overrides,
  };
}

describe('evaluateSybilCluster', () => {
  it('triggers for cached shared-funder clusters with same-market activity', () => {
    const signal = evaluateSybilCluster({
      fill: makeFill(),
      cluster: {
        fundingClusterId: 'fc:abc',
        clusterSize: 3,
        sameMarketSameSideEntries: 2,
      },
      config: makeConfig(),
    });

    expect(signal?.signalId).toBe('SYBIL_CLUSTER');
    expect(signal?.score).toBe(30);
    expect(signal?.confidence).toBe(0.9);
  });

  it('does not trigger without enough same-market entries', () => {
    const signal = evaluateSybilCluster({
      fill: makeFill(),
      cluster: {
        fundingClusterId: 'fc:abc',
        clusterSize: 3,
        sameMarketSameSideEntries: 1,
      },
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('does not trigger for dust fills even when the cluster pattern exists', () => {
    const signal = evaluateSybilCluster({
      fill: makeFill({ sizeUsd: '10.000000' }),
      cluster: {
        fundingClusterId: 'fc:abc',
        clusterSize: 470,
        sameMarketSameSideEntries: 2,
      },
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('returns base score for fills between min and elevated thresholds', () => {
    const signal = evaluateSybilCluster({
      fill: makeFill({ sizeUsd: '300.000000' }),
      cluster: {
        fundingClusterId: 'fc:abc',
        clusterSize: 5,
        sameMarketSameSideEntries: 2,
      },
      config: makeConfig(),
    });

    expect(signal?.signalId).toBe('SYBIL_CLUSTER');
    expect(signal?.score).toBe(15);
    expect(signal?.confidence).toBe(0.8);
  });

  it('returns elevated score for fills above elevated threshold', () => {
    const signal = evaluateSybilCluster({
      fill: makeFill({ sizeUsd: '600.000000' }),
      cluster: {
        fundingClusterId: 'fc:abc',
        clusterSize: 5,
        sameMarketSameSideEntries: 2,
      },
      config: makeConfig(),
    });

    expect(signal?.signalId).toBe('SYBIL_CLUSTER');
    expect(signal?.score).toBe(30);
    expect(signal?.confidence).toBe(0.9);
  });
});
