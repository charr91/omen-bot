import { describe, expect, it, vi } from 'vitest';
import { MarketVolumeRefiner, tradeTapeVolume24h } from '../../../src/markets/volume.js';
import { extractGameStartTime } from '../../../src/phase0/public-api.js';

const at = new Date('2026-10-13T00:01:48Z');
const t = (secAgo: number, usd: number) => ({ timestamp: Math.floor(at.getTime() / 1000) - secAgo, size: usd / 0.5, price: 0.5 });

describe('market daily volume', () => {
  it('sums the 24h trade tape before the fill, ignoring trades after it or older than 24h', async () => {
    const fetcher = vi.fn().mockResolvedValue([t(-60, 9999), t(60, 1000), t(3600, 2688), t(90_000, 5000)]);
    expect(await tradeTapeVolume24h('0xm', at, fetcher)).toBeCloseTo(3688);
  });

  it('uses the larger of Gamma and the tape, falls back to Gamma on errors, and caches', async () => {
    const fetcher = vi.fn().mockResolvedValue([t(60, 3688)]);
    const refiner = new MarketVolumeRefiner(fetcher, 60_000, () => at.getTime());
    expect(await refiner.dailyVolumeUsd('0xm', '617.42', at)).toEqual({ value: '3688.000000', source: 'trades' });
    await refiner.dailyVolumeUsd('0xm', '617.42', at);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await refiner.dailyVolumeUsd('0xm2', '50000', at)).toEqual({ value: '50000', source: 'gamma' });
    const failing = new MarketVolumeRefiner(vi.fn().mockRejectedValue(new Error('down')));
    expect(await failing.dailyVolumeUsd('0xm', '617.42', at)).toEqual({ value: '617.42', source: 'gamma' });
  });

  it('reads the game start from Gamma gameStartTime, else the event startTime', () => {
    expect(extractGameStartTime({ gameStartTime: '2026-10-13 00:00:00+00' })).toBe('2026-10-13T00:00:00.000Z');
    expect(extractGameStartTime({ events: [{ startTime: '2026-10-13T00:00:00Z' }] })).toBe('2026-10-13T00:00:00.000Z');
    expect(extractGameStartTime({ question: 'Fed cut?' })).toBeNull();
  });
});
