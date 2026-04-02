import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { evaluateFreshWalletLargePosition } from '../../../src/signals/fresh-wallet-large-position.js';
import type { FillRecord } from '../../../src/types/fill.js';
import type { MarketInfo } from '../../../src/types/market.js';
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
    firstSeenAt: new Date('2026-03-30T00:00:00.000Z'),
    lastActiveAt: new Date('2026-03-30T00:10:00.000Z'),
    totalMarkets: 1,
    totalFills: 1,
    totalVolumeUsd: '1500.000000',
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
    shares: '3000.000000',
    sizeUsd: '1500.000000',
    txHash: '0xtx-1',
    orderType: 'UNKNOWN',
    timestamp: new Date('2026-03-30T00:10:00.000Z'),
    analyzed: false,
    createdAt: new Date('2026-03-30T00:10:00.000Z'),
    ...overrides,
  };
}

function makeMarket(overrides: Partial<MarketInfo> = {}): MarketInfo {
  return {
    id: 'market-1',
    question: 'Question?',
    marketSlug: 'question',
    dailyVolumeUsd: '50000.000000',
    volumeUsd: '50000.000000',
    liquidityUsd: '1000.000000',
    ...overrides,
  };
}

describe('evaluateFreshWalletLargePosition', () => {
  it('triggers for a fresh wallet making a large position', () => {
    const signal = evaluateFreshWalletLargePosition({
      fill: makeFill(),
      wallet: makeWallet(),
      market: makeMarket(),
      config: makeConfig(),
    });

    expect(signal).not.toBeNull();
    expect(signal?.signalId).toBe('FRESH_WALLET_LARGE_POSITION');
    expect(signal?.score).toBe(30);
  });

  it('uses the elevated score for 24-72 hour wallets', () => {
    const signal = evaluateFreshWalletLargePosition({
      fill: makeFill(),
      wallet: makeWallet({ ageSeconds: 36 * 3600 }),
      market: makeMarket(),
      config: makeConfig(),
    });

    expect(signal?.score).toBe(18);
  });

  it('does not trigger when the fill is below the large-position threshold', () => {
    const signal = evaluateFreshWalletLargePosition({
      fill: makeFill({ sizeUsd: '500.000000' }),
      wallet: makeWallet(),
      market: makeMarket(),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('does not trigger on non-niche markets', () => {
    const signal = evaluateFreshWalletLargePosition({
      fill: makeFill(),
      wallet: makeWallet(),
      market: makeMarket({ dailyVolumeUsd: '150000.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });

  it('does not trigger when wallet age is unknown', () => {
    const signal = evaluateFreshWalletLargePosition({
      fill: makeFill(),
      wallet: makeWallet({ activityAgeKnown: false }),
      market: makeMarket(),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });
});
