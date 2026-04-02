import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { evaluateConvictionSizeMismatch } from '../../../src/signals/conviction-size-mismatch.js';
import type { FillRecord } from '../../../src/types/fill.js';
import type { WalletProfile } from '../../../src/types/wallet.js';

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

function makeWallet(overrides: Partial<WalletProfile> = {}): WalletProfile {
  return {
    address: '0xwallet',
    ageSeconds: 3600,
    activityAgeKnown: true,
    totalTransactions: 2,
    isContract: false,
    controllerAddress: null,
    freshnessAgeSeconds: 3600,
    freshnessActivityAgeKnown: true,
    freshnessTotalTransactions: 2,
    firstSeenAt: new Date('2026-03-30T00:00:00.000Z'),
    lastActiveAt: new Date('2026-03-30T00:10:00.000Z'),
    totalMarkets: 1,
    totalFills: 2,
    totalVolumeUsd: '3000.000000',
    fundingClusterId: null,
    liveSuspicionScore: 0,
    liveTier: 'CLEAN',
    isWhitelisted: false,
    ...overrides,
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

describe('evaluateConvictionSizeMismatch', () => {
  it('fires when a small wallet makes a longshot bet that dominates its history', () => {
    const signal = evaluateConvictionSizeMismatch({
      fill: makeFill(),
      wallet: makeWallet(),
      config: makeConfig(),
    });

    expect(signal?.signalId).toBe('CONVICTION_SIZE_MISMATCH');
    expect(signal?.score).toBe(14);
  });

  it('does not fire for larger wallets', () => {
    const signal = evaluateConvictionSizeMismatch({
      fill: makeFill(),
      wallet: makeWallet({ totalVolumeUsd: '7500.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('does not fire for clustered wallets or higher-priced fills', () => {
    const clusteredSignal = evaluateConvictionSizeMismatch({
      fill: makeFill(),
      wallet: makeWallet({ fundingClusterId: 'cluster-1' }),
      config: makeConfig(),
    });
    const highPriceSignal = evaluateConvictionSizeMismatch({
      fill: makeFill({ price: '0.400000' }),
      wallet: makeWallet(),
      config: makeConfig(),
    });

    expect(clusteredSignal).toBeNull();
    expect(highPriceSignal).toBeNull();
  });

  it('does not fire on a wallet first fill even if the current fill dominates total volume', () => {
    const signal = evaluateConvictionSizeMismatch({
      fill: makeFill(),
      wallet: makeWallet({ totalFills: 1, totalVolumeUsd: '1500.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });
});
