import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { evaluateNicheMarketEntry } from '../../../src/signals/niche-market-entry.js';
import type { FillRecord } from '../../../src/types/fill.js';
import type { MarketInfo } from '../../../src/types/market.js';

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
    question: 'Question?',
    marketSlug: 'question',
    dailyVolumeUsd: '50000.000000',
    volumeUsd: '500000.000000',
    liquidityUsd: '1000.000000',
    ...overrides,
  };
}

describe('evaluateNicheMarketEntry', () => {
  it('triggers for large fills on niche markets', () => {
    const signal = evaluateNicheMarketEntry({
      fill: makeFill(),
      market: makeMarket(),
      config: makeConfig(),
    });

    expect(signal?.signalId).toBe('NICHE_MARKET_ENTRY');
    expect(signal?.score).toBe(7);
  });

  it('does not trigger on broad markets', () => {
    const signal = evaluateNicheMarketEntry({
      fill: makeFill(),
      market: makeMarket({ dailyVolumeUsd: '150000.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });
});
