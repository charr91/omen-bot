import { fetchActiveMarkets, fetchMarketsByConditionIds } from '../phase0/public-api.js';
import type { MarketInfo } from '../types/market.js';

interface ActiveMarketCatalogOptions {
  cacheTtlMs?: number;
  fetchMarkets?: typeof fetchActiveMarkets;
  fetchMarketsByIds?: typeof fetchMarketsByConditionIds | null;
  now?: () => number;
}

const DEFAULT_ACTIVE_MARKET_CACHE_TTL_MS = 60_000;
const ON_DEMAND_MARKET_CACHE_TTL_MS = 300_000;
const MAX_ON_DEMAND_ENTRIES = 20_000;

export class ActiveMarketCatalog {
  private readonly markets = new Map<string, MarketInfo>();
  private readonly cacheTtlMs: number;
  private readonly fetchMarkets: typeof fetchActiveMarkets;
  private readonly fetchMarketsByIds: typeof fetchMarketsByConditionIds | null;
  private readonly onDemand = new Map<string, { expiresAt: number; value: MarketInfo | null }>();
  private readonly now: () => number;
  private refreshedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(options: ActiveMarketCatalogOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_ACTIVE_MARKET_CACHE_TTL_MS;
    this.fetchMarkets = options.fetchMarkets ?? fetchActiveMarkets;
    // box-dry-run: on-demand lookup only for the real fetcher unless explicitly injected (keeps tests offline).
    this.fetchMarketsByIds =
      options.fetchMarketsByIds !== undefined
        ? options.fetchMarketsByIds
        : options.fetchMarkets
          ? null
          : fetchMarketsByConditionIds;
    this.now = options.now ?? (() => Date.now());
  }

  async getMarket(marketId: string): Promise<MarketInfo | null> {
    if (!this.isFresh()) {
      await this.refresh();
    }

    return this.markets.get(marketId) ?? (await this.lookupOnDemand(marketId));
  }

  // box-dry-run: Gamma's active listing is capped at ~2100 markets by offset, so most traded
  // markets were missing (market=null => no signals). Fall back to a condition_ids lookup.
  private async lookupOnDemand(marketId: string): Promise<MarketInfo | null> {
    if (this.fetchMarketsByIds === null) {
      return null;
    }
    const now = this.now();
    const cached = this.onDemand.get(marketId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const [market] = (await this.fetchMarketsByIds([marketId])).filter((entry) => entry.conditionId === marketId);
    const value: MarketInfo | null = market
      ? {
          id: market.conditionId,
          eventSlug: market.eventSlug,
          question: market.question,
          marketSlug: market.marketSlug,
          dailyVolumeUsd: market.dailyVolumeUsd,
          gameStartTime: market.gameStartTime ?? null,
          volumeUsd: market.volumeUsd,
          liquidityUsd: market.liquidityUsd,
        }
      : null;
    if (this.onDemand.size >= MAX_ON_DEMAND_ENTRIES) {
      this.onDemand.clear();
    }
    this.onDemand.set(marketId, { expiresAt: now + ON_DEMAND_MARKET_CACHE_TTL_MS, value });
    return value;
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
          eventSlug: market.eventSlug,
          question: market.question,
          marketSlug: market.marketSlug,
          dailyVolumeUsd: market.dailyVolumeUsd,
          gameStartTime: market.gameStartTime ?? null,
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
