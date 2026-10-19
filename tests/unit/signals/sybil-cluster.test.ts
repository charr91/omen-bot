import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { computeDeliverableLiveScore } from '../../../src/signals/evaluate-live-signals.js';
import { isShadowSignal } from '../../../src/signals/fresh-wallet-longshot.js';
import { evaluateSybilCluster, keepFirstSybilPerClusterMarket, sybilClusterMarketKey } from '../../../src/signals/sybil-cluster.js';
import { SignalId } from '../../../src/types/signal.js';
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
    expect(signal?.score).toBe(35);
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
    expect(signal?.score).toBe(20);
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
    expect(signal?.score).toBe(35);
    expect(signal?.confidence).toBe(0.9);
  });
});

describe('SYBIL_CLUSTER delivery + mega-cluster settings', () => {
  const withSybil = (deliver: boolean) => ({
    detection: { ...makeConfig().detection, sybilCluster: { deliver, maxClusterSize: 50, excludedFunders: [] } },
  });
  const cluster = (clusterSize: number) => ({ fundingClusterId: 'fc:abc', clusterSize, sameMarketSameSideEntries: 2 });

  it('ignores clusters larger than max_cluster_size', () => {
    expect(evaluateSybilCluster({ fill: makeFill(), cluster: cluster(50), config: withSybil(true) })).not.toBeNull();
    expect(evaluateSybilCluster({ fill: makeFill(), cluster: cluster(51), config: withSybil(true) })).toBeNull();
  });

  it('is shadow when deliver = false and contributes nothing to the deliverable score', () => {
    const shadow = evaluateSybilCluster({ fill: makeFill(), cluster: cluster(5), config: withSybil(false) })!;
    expect(isShadowSignal(shadow)).toBe(true);
    expect(computeDeliverableLiveScore([shadow])).toBe(0);
    expect(isShadowSignal(evaluateSybilCluster({ fill: makeFill(), cluster: cluster(5), config: withSybil(true) })!)).toBe(false);
  });
});

describe('keepFirstSybilPerClusterMarket', () => {
  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
    };
  }
  const sybil = { signalId: SignalId.SYBIL_CLUSTER };
  const other = { signalId: SignalId.CONVICTION_SIZE_MISMATCH };

  it('keeps only the first SYBIL signal per cluster and market', async () => {
    const redis = fakeRedis();
    const first = await keepFirstSybilPerClusterMarket([sybil, other], { clusterId: 'fc:1', marketId: 'm1', fillId: 'f1' }, redis as never);
    const second = await keepFirstSybilPerClusterMarket([sybil, other], { clusterId: 'fc:1', marketId: 'm1', fillId: 'f2' }, redis as never);
    const otherMarket = await keepFirstSybilPerClusterMarket([sybil], { clusterId: 'fc:1', marketId: 'm2', fillId: 'f3' }, redis as never);
    const replay = await keepFirstSybilPerClusterMarket([sybil], { clusterId: 'fc:1', marketId: 'm1', fillId: 'f1' }, redis as never);
    expect(first).toEqual([sybil, other]);
    expect(second).toEqual([other]);
    expect(otherMarket).toEqual([sybil]);
    expect(replay).toEqual([sybil]);
    expect(redis.store.get(sybilClusterMarketKey('fc:1', 'm1'))).toBe('f1');
  });

  it('does not touch Redis without a SYBIL signal or cluster', async () => {
    const redis = fakeRedis();
    expect(await keepFirstSybilPerClusterMarket([other], { clusterId: 'fc:1', marketId: 'm1', fillId: 'f1' }, redis as never)).toEqual([other]);
    expect(await keepFirstSybilPerClusterMarket([sybil], { clusterId: null, marketId: 'm1', fillId: 'f1' }, redis as never)).toEqual([sybil]);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
