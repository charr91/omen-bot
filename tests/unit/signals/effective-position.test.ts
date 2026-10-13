import { describe, expect, it } from 'vitest';
import { effectivePosition } from '../../../src/signals/effective-position.js';
import { evaluateConvictionSizeMismatch } from '../../../src/signals/conviction-size-mismatch.js';
import { formatAlertTradeAction } from '../../../src/alerts/presentation.js';

const config = {
  detection: {
    convictionSizeMismatch: { minFillUsd: 500, maxWalletTotalVolumeUsd: 5000, minFillToWalletVolumeRatio: 1, longshotMaxPrice: 0.3 },
  },
} as never;

function ctx(side: 'BUY' | 'SELL', price: number, shares: number) {
  return {
    fill: { side, outcome: 'YES', price: String(price), shares: String(shares), sizeUsd: String(price * shares) } as never,
    wallet: { fundingClusterId: null, totalVolumeUsd: String(1530 + price * shares), totalFills: 2, activityAgeKnown: false, ageSeconds: 0 } as never,
    config,
  };
}

describe('effective side and price', () => {
  it('a SELL of YES at 0.24 is long NO at 0.76 with shares x 0.76 at risk', () => {
    const p = effectivePosition({ side: 'SELL', outcome: 'YES', price: '0.242', shares: '10000', sizeUsd: '2420' });
    expect(p?.outcome).toBe('NO');
    expect(p?.price).toBeCloseTo(0.758);
    expect(p?.stakeUsd).toBeCloseTo(7580);
    expect(effectivePosition({ side: 'BUY', outcome: 'NO', price: '0.2', shares: '100', sizeUsd: '20' })).toMatchObject({ outcome: 'NO', price: 0.2 });
  });

  it('CONVICTION_SIZE_MISMATCH no longer treats selling a longshot as buying one', () => {
    expect(evaluateConvictionSizeMismatch(ctx('SELL', 0.242, 10_000))).toBeNull();
    const buy = evaluateConvictionSizeMismatch(ctx('BUY', 0.242, 10_000));
    expect(buy?.evidence.find((e) => e.field === 'effective_outcome')?.value).toBe('YES');
    // Selling a heavy favourite is a longshot on the other side.
    const sellFav = evaluateConvictionSizeMismatch(ctx('SELL', 0.8, 15_000));
    expect(sellFav?.evidence.find((e) => e.field === 'effective_outcome')?.value).toBe('NO');
    expect(sellFav?.evidence.find((e) => e.field === 'fill_price')?.value).toBeCloseTo(0.2);
  });

  it('alert text shows the effective side for sells', () => {
    expect(formatAlertTradeAction({ fillSide: 'SELL', fillOutcome: 'YES', fillPrice: '0.242' })).toMatch(/Sold YES @ .*≈ long NO @/);
  });
});
