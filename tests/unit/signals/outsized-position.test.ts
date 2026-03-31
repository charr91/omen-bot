import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { evaluateOutsizedPosition } from '../../../src/signals/outsized-position.js';
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
    volumeUsd: '500000.000000',
    liquidityUsd: '1000.000000',
    ...overrides,
  };
}

describe('evaluateOutsizedPosition', () => {
  it('triggers when the absolute threshold is dominant', () => {
    const signal = evaluateOutsizedPosition({
      fill: makeFill({ sizeUsd: '1200.000000' }),
      market: makeMarket({ dailyVolumeUsd: '10000.000000' }),
      config: makeConfig(),
    });

    expect(signal?.signalId).toBe('OUTSIZED_POSITION');
    expect(signal?.score).toBe(12);
  });

  it('triggers when the relative threshold is dominant', () => {
    const signal = evaluateOutsizedPosition({
      fill: makeFill({ sizeUsd: '2500.000000' }),
      market: makeMarket({ dailyVolumeUsd: '100000.000000' }),
      config: makeConfig(),
    });

    expect(signal?.signalId).toBe('OUTSIZED_POSITION');
    expect(signal?.evidence.find((evidence) => evidence.field === 'threshold_basis')?.value).toBe('relative');
  });

  it('does not trigger below the market-relative threshold', () => {
    const signal = evaluateOutsizedPosition({
      fill: makeFill({ sizeUsd: '900.000000' }),
      market: makeMarket({ dailyVolumeUsd: '40000.000000' }),
      config: makeConfig(),
    });

    expect(signal).toBeNull();
  });
});
