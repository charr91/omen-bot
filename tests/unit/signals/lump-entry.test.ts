import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { evaluateLumpEntry } from '../../../src/signals/lump-entry.js';
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
        minFillUsd: 25,
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
    ageSeconds: 7 * 24 * 3600,
    activityAgeKnown: true,
    totalTransactions: 10,
    isContract: false,
    controllerAddress: null,
    freshnessAgeSeconds: 7 * 24 * 3600,
    freshnessActivityAgeKnown: true,
    freshnessTotalTransactions: 10,
    firstSeenAt: new Date('2026-03-23T00:00:00.000Z'),
    lastActiveAt: new Date('2026-03-30T00:10:00.000Z'),
    totalMarkets: 3,
    totalFills: 5,
    totalVolumeUsd: '2200.000000',
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
    price: '0.500000',
    shares: '2400.000000',
    sizeUsd: '1200.000000',
    txHash: '0xtx-1',
    orderType: 'UNKNOWN',
    timestamp: new Date('2026-03-30T00:10:00.000Z'),
    analyzed: false,
    createdAt: new Date('2026-03-30T00:10:00.000Z'),
    ...overrides,
  };
}

describe('evaluateLumpEntry', () => {
  it('fires when fill dominates prior wallet volume', () => {
    const signal = evaluateLumpEntry({
      fill: makeFill(),
      wallet: makeWallet(),
      config: makeConfig(),
    });

    expect(signal?.signalId).toBe('LUMP_ENTRY');
    expect(signal?.score).toBe(8);
    expect(signal?.confidence).toBe(0.7);
    expect(signal?.availability).toBe('LIVE');
  });

  it('does not fire when ratio is below threshold', () => {
    const signal = evaluateLumpEntry({
      fill: makeFill({ sizeUsd: '300.000000' }),
      wallet: makeWallet({ totalVolumeUsd: '1300.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('does not fire when fill is below minimum USD', () => {
    const signal = evaluateLumpEntry({
      fill: makeFill({ sizeUsd: '400.000000' }),
      wallet: makeWallet({ totalVolumeUsd: '700.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('does not fire for whitelisted wallets', () => {
    const signal = evaluateLumpEntry({
      fill: makeFill(),
      wallet: makeWallet({ isWhitelisted: true }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('does not fire on wallet first fill', () => {
    const signal = evaluateLumpEntry({
      fill: makeFill(),
      wallet: makeWallet({ totalFills: 1, totalVolumeUsd: '1200.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('does not fire when prior volume is zero', () => {
    const signal = evaluateLumpEntry({
      fill: makeFill({ sizeUsd: '1200.000000' }),
      wallet: makeWallet({ totalFills: 3, totalVolumeUsd: '1200.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });
});
