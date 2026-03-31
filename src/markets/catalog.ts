import { fetchActiveMarkets } from '../phase0/public-api.js';
import type { MarketInfo } from '../types/market.js';

interface ActiveMarketCatalogOptions {
  cacheTtlMs?: number;
  fetchMarkets?: typeof fetchActiveMarkets;
  now?: () => number;
}

const DEFAULT_ACTIVE_MARKET_CACHE_TTL_MS = 60_000;

export class ActiveMarketCatalog {
  private readonly markets = new Map<string, MarketInfo>();
  private readonly cacheTtlMs: number;
  private readonly fetchMarkets: typeof fetchActiveMarkets;
  private readonly now: () => number;
  private refreshedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(options: ActiveMarketCatalogOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_ACTIVE_MARKET_CACHE_TTL_MS;
    this.fetchMarkets = options.fetchMarkets ?? fetchActiveMarkets;
    this.now = options.now ?? (() => Date.now());
  }

  async getMarket(marketId: string): Promise<MarketInfo | null> {
    if (this.isFresh()) {
      return this.markets.get(marketId) ?? null;
    }

    await this.refresh();
    return this.markets.get(marketId) ?? null;
  }

  private isFresh(): boolean {
    return this.refreshedAt !== 0 && this.now() - this.refreshedAt < this.cacheTtlMs;
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise !== null) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const result = await this.fetchMarkets();
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
      this.refreshedAt = this.now();
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }
}
