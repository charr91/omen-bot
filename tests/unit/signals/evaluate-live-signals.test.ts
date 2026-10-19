import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { computeCompositeLiveScore, evaluateLiveSignals } from '../../../src/signals/evaluate-live-signals.js';
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
      excludedCategories: {},
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

function makeMarket(overrides: Partial<MarketInfo> = {}): MarketInfo {
  return {
    id: 'market-1',
    eventSlug: null,
    question: 'Question?',
    marketSlug: 'question',
    dailyVolumeUsd: '50000.000000',
    volumeUsd: '500000.000000',
    liquidityUsd: '1000.000000',
    ...overrides,
  };
}

describe('evaluateLiveSignals', () => {
  it('returns both fresh-wallet and outsized-position signals when both conditions hold', () => {
    const signals = evaluateLiveSignals({
      fill: makeFill(),
      wallet: makeWallet(),
      market: makeMarket(),
      config: {
        detection: {
          ...makeConfig().detection,
          nicheMarketEntry: {
            maxMarketVolumeUsd: 100_000,
            minFillUsd: 2_000,
          },
          convictionSizeMismatch: {
            maxWalletTotalVolumeUsd: 5_000,
            minFillToWalletVolumeRatio: 0.5,
            longshotMaxPrice: 0.3,
            minFillUsd: 2_000,
          },
          lumpEntry: {
            minFillUsd: 2_000,
            minLumpRatio: 0.8,
          },
        },
      },
      cluster: null,
    });

    expect(signals.map((signal) => signal.signalId)).toEqual([
      'OUTSIZED_POSITION',
      'FRESH_WALLET_LARGE_POSITION',
    ]);
    expect(computeCompositeLiveScore(signals)).toBe(42);
  });

  it('returns only outsized-position for contract wallets', () => {
    const signals = evaluateLiveSignals({
      fill: makeFill(),
      wallet: makeWallet({ isContract: true, activityAgeKnown: false }),
      market: makeMarket(),
      config: {
        detection: {
          ...makeConfig().detection,
          nicheMarketEntry: {
            maxMarketVolumeUsd: 100_000,
            minFillUsd: 2_000,
          },
          convictionSizeMismatch: {
            maxWalletTotalVolumeUsd: 5_000,
            minFillToWalletVolumeRatio: 0.5,
            longshotMaxPrice: 0.3,
            minFillUsd: 2_000,
          },
          lumpEntry: {
            minFillUsd: 2_000,
            minLumpRatio: 0.8,
          },
        },
      },
      cluster: null,
    });

    expect(signals.map((signal) => signal.signalId)).toEqual(['OUTSIZED_POSITION']);
  });

  it('skips all live signals for markets matching excluded categories', () => {
    const config = makeConfig();
    config.detection.excludedCategories = {
      weather: ['weather', 'rain'],
    };
    const signals = evaluateLiveSignals({
      fill: makeFill(),
      wallet: makeWallet(),
      market: makeMarket({
        eventSlug: 'will-it-rain-in-new-york',
        question: 'Will it rain in New York on April 5?',
      }),
      config,
      cluster: null,
    });

    expect(signals).toEqual([]);
  });

  it('skips all live signals for sports markets by metadata when filters exclude sports', () => {
    const market = makeMarket({ question: 'Will AC Monza win?', tags: ['sports', 'soccer'] });
    const base = { fill: makeFill(), wallet: makeWallet(), market, cluster: null };
    expect(evaluateLiveSignals({ ...base, config: makeConfig() }).length).toBeGreaterThan(0);
    expect(evaluateLiveSignals({ ...base, config: { ...makeConfig(), filters: { excludeCategories: ['sports'] } } })).toEqual([]);
  });

  it('skips all live signals for whitelisted wallets', () => {
    const signals = evaluateLiveSignals({
      fill: makeFill(),
      wallet: makeWallet({ isWhitelisted: true }),
      market: makeMarket(),
      config: makeConfig(),
      cluster: null,
    });

    expect(signals).toEqual([]);
  });
});
