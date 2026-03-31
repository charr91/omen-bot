import { fetchActiveMarkets } from '../phase0/public-api.js';
import type { MarketInfo } from '../types/market.js';

const ACTIVE_MARKET_CACHE_TTL_MS = 60_000;

export class ActiveMarketCatalog {
  private readonly markets = new Map<string, MarketInfo>();
  private refreshedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  async getMarket(marketId: string): Promise<MarketInfo | null> {
    if (this.isFresh() && this.markets.has(marketId)) {
      return this.markets.get(marketId) ?? null;
    }

    await this.refresh();
    return this.markets.get(marketId) ?? null;
  }

  private isFresh(): boolean {
    return this.refreshedAt !== 0 && Date.now() - this.refreshedAt < ACTIVE_MARKET_CACHE_TTL_MS;
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise !== null) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const result = await fetchActiveMarkets();
      this.markets.clear();
      for (const market of result.markets) {
        this.markets.set(market.conditionId, {
          id: market.conditionId,
          question: market.question,
          marketSlug: market.marketSlug,
          dailyVolumeUsd: market.dailyVolumeUsd,
          volumeUsd: market.volumeUsd,
          liquidityUsd: market.liquidityUsd,
        });
      }
      this.refreshedAt = Date.now();
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }
}
