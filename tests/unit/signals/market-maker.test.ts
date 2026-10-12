import { describe, expect, it } from 'vitest';
import { calculateMarketMakerScore, isLikelyMarketMaker } from '../../../src/signals/market-maker.js';

describe('calculateMarketMakerScore (insider-poly-bot port)', () => {
  it('matches the Python docstring examples', () => {
    expect(
      calculateMarketMakerScore({
        tradeCount: 150,
        buyVolumeUsd: 50_000,
        sellVolumeUsd: 48_000,
        marketsCount: 12,
        firstSeenAt: new Date('2024-01-01'),
        lastSeenAt: new Date('2024-01-15'),
      }),
    ).toBe(100);
    expect(
      calculateMarketMakerScore({
        tradeCount: 10,
        buyVolumeUsd: 500_000,
        sellVolumeUsd: 5_000,
        marketsCount: 2,
        firstSeenAt: new Date('2024-01-10'),
        lastSeenAt: new Date('2024-01-11'),
      }),
    ).toBe(0);
  });

  it('scores loose balance, medium frequency and several markets', () => {
    const score = calculateMarketMakerScore({
      tradeCount: 60,
      buyVolumeUsd: 58,
      sellVolumeUsd: 42,
      marketsCount: 6,
      firstSeenAt: new Date('2024-01-01'),
      lastSeenAt: new Date('2024-01-04'),
    });
    expect(score).toBe(20 + 20 + 10 + 5);
    expect(isLikelyMarketMaker(score)).toBe(false);
    expect(isLikelyMarketMaker(70)).toBe(true);
  });
});
