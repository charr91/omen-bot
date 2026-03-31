import { describe, expect, it, vi } from 'vitest';
import { ActiveMarketCatalog } from '../../../src/markets/catalog.js';

function makeMarket(conditionId: string) {
  return {
    conditionId,
    marketSlug: conditionId,
    question: `Question for ${conditionId}`,
    dailyVolumeUsd: '1000.000000',
    volumeUsd: '5000.000000',
    liquidityUsd: '2500.000000',
  };
}

describe('ActiveMarketCatalog', () => {
  it('does not refresh again for unknown markets while the cache is still fresh', async () => {
    let now = 1_000;
    const fetchMarkets = vi.fn<typeof import('../../../src/phase0/public-api.js').fetchActiveMarkets>().mockResolvedValue({
      markets: [makeMarket('known-market')],
    });
    const catalog = new ActiveMarketCatalog({
      fetchMarkets,
      cacheTtlMs: 60_000,
      now: () => now,
    });

    await expect(catalog.getMarket('known-market')).resolves.toMatchObject({ id: 'known-market' });
    await expect(catalog.getMarket('missing-market')).resolves.toBeNull();

    expect(fetchMarkets).toHaveBeenCalledTimes(1);
    now += 30_000;
    await expect(catalog.getMarket('another-missing-market')).resolves.toBeNull();
    expect(fetchMarkets).toHaveBeenCalledTimes(1);
  });

  it('refreshes stale caches and can discover markets that appeared after the prior snapshot', async () => {
    let now = 1_000;
    const fetchMarkets = vi
      .fn<typeof import('../../../src/phase0/public-api.js').fetchActiveMarkets>()
      .mockResolvedValueOnce({
        markets: [makeMarket('known-market')],
      })
      .mockResolvedValueOnce({
        markets: [makeMarket('known-market'), makeMarket('new-market')],
      });
    const catalog = new ActiveMarketCatalog({
      fetchMarkets,
      cacheTtlMs: 60_000,
      now: () => now,
    });

    await expect(catalog.getMarket('missing-market')).resolves.toBeNull();
    now += 61_000;

    await expect(catalog.getMarket('new-market')).resolves.toMatchObject({ id: 'new-market' });
    expect(fetchMarkets).toHaveBeenCalledTimes(2);
  });
});
