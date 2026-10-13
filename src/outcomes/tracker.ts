import { buildVolumeBaseline, detectVolumeSpike } from '../signals/volume-baseline.js';
import type { MarketMakerStore } from '../persistence/queries/market-maker.js';
import { fetchMarketResolutions, fetchTokenPriceAt, type MarketResolution } from './polymarket.js';
import type { Horizon, TradeOutcomeStore } from './store.js';
import { fetchMarketsByConditionIds } from '../phase0/public-api.js';

/** Gamma game start per condition id (lower-cased); markets Gamma did not return are absent. */
export async function fetchGameStarts(conditionIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < conditionIds.length; i += 20) {
    for (const market of await fetchMarketsByConditionIds(conditionIds.slice(i, i + 20))) {
      out.set(market.conditionId.toLowerCase(), market.gameStartTime ?? null);
    }
  }
  return out;
}

export interface OutcomeTrackerOptions {
  store: TradeOutcomeStore;
  marketMakers: Pick<MarketMakerStore, 'listLikelyMarketMakers'>;
  baselinePerSignal: number;
  baselineWindowHours: number;
  marketMakerMinScore: number;
  enrollLookbackDays?: number;
  batchSize?: number;
  now?: () => Date;
  priceAt?: (tokenId: string, at: Date) => Promise<number | null>;
  resolutions?: (conditionIds: string[]) => Promise<MarketResolution[]>;
  /** Game start per condition id (ISO or null); default reads Gamma. */
  gameStarts?: (conditionIds: string[]) => Promise<Map<string, string | null>>;
  /** Kalshi grading; when omitted, Kalshi rows are left alone. */
  kalshi?: {
    priceAt(eventTicker: string, ticker: string, at: Date): Promise<number | null>;
    /** Final YES price per ticker for settled markets (1 = YES won, 0 = NO won). */
    settlements(tickers: string[]): Promise<Record<string, number>>;
  };
}

export interface OutcomeTrackerRunResult {
  enrolled: number;
  baselines: number;
  volumeContext: number;
  prices1h: number;
  prices24h: number;
  resolved: number;
  errors: string[];
}

const PRICE_RETRY_MS = 30 * 60_000;
const RESOLUTION_RETRY_MS = 60 * 60_000;
const FILL_FALLBACK_WINDOW_MS = 30 * 60_000;
const VOLUME_BASELINE_DAYS = 7;
const MM_CACHE_MS = 60 * 60_000;

/**
 * Grades signal fills and their same-market baseline fills: price at +1h and +24h, market resolution, and a
 * time-of-day volume-spike flag for the hour before each signal.
 */
export class OutcomeTracker {
  private mmCache: { at: number; wallets: string[] } | null = null;

  constructor(private readonly options: OutcomeTrackerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async runOnce(): Promise<OutcomeTrackerRunResult> {
    const { store } = this.options;
    const batch = this.options.batchSize ?? 50;
    const now = this.now();
    const result: OutcomeTrackerRunResult = {
      enrolled: 0,
      baselines: 0,
      volumeContext: 0,
      prices1h: 0,
      prices24h: 0,
      resolved: 0,
      errors: [],
    };
    const attempt = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        result.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    await attempt('enroll', async () => {
      const since = new Date(now.getTime() - (this.options.enrollLookbackDays ?? 30) * 86_400_000);
      result.enrolled = await store.enrollSignalFills(since);
      if (this.options.kalshi) result.enrolled += await store.enrollKalshiSignals(since);
    });

    // Before baselines: they are matched on in-play status, so the signal's game start must be known first.
    await attempt('game start', async () => {
      const markets = await store.listMarketsMissingGameStart(40);
      if (markets.length === 0) return;
      const starts = await (this.options.gameStarts ?? fetchGameStarts)(markets);
      for (const marketId of markets) {
        if (!starts.has(marketId.toLowerCase())) continue; // Gamma had no row: retry next run
        const iso = starts.get(marketId.toLowerCase()) ?? null;
        await store.setGameStart(marketId, iso ? new Date(iso) : null, now);
      }
    });

    await attempt('baseline', async () => {
      result.baselines = await store.sampleBaselines(
        this.options.baselinePerSignal,
        this.options.baselineWindowHours,
        batch * 4,
        await this.likelyMarketMakers(now),
      );
      if (this.options.kalshi) {
        result.baselines += await store.sampleKalshiBaselines(
          this.options.baselinePerSignal,
          this.options.baselineWindowHours,
          batch * 4,
        );
      }
    });

    await attempt('volume', async () => {
      for (const row of await store.listSignalRowsMissingContext(batch)) {
        const alertHour = new Date(Math.floor(row.alertAt.getTime() / 3_600_000) * 3_600_000);
        const from = new Date(alertHour.getTime() - VOLUME_BASELINE_DAYS * 86_400_000);
        const hourly = await store.listMarketHourlyVolume(row.marketId, from, row.alertAt);
        const history = hourly.filter((h) => h.hour.getTime() < alertHour.getTime());
        const current = hourly.find((h) => h.hour.getTime() === alertHour.getTime())?.volumeUsd ?? 0;
        const firstHour = history.reduce((min, h) => Math.min(min, h.hour.getTime()), alertHour.getTime());
        const baseline = buildVolumeBaseline(
          history.map((h) => ({ timestamp: h.hour, volumeUsd: h.volumeUsd })),
          new Date(Math.max(firstHour, from.getTime())),
          alertHour,
        );
        const spike = detectVolumeSpike(current, baseline, row.alertAt);
        await store.setVolumeContext(row.fillId, spike.isSpike, spike.multiplier);
        result.volumeContext += 1;
      }
    });

    for (const horizon of ['1h', '24h'] as Horizon[]) {
      await attempt(`price ${horizon}`, async () => {
        for (const row of await store.listPendingPrices(horizon, now, PRICE_RETRY_MS, batch)) {
          let price: number | null = null;
          if (row.venue === 'kalshi') {
            if (!this.options.kalshi) continue;
            try {
              const eventTicker = await store.getKalshiEventTicker(row.tokenId);
              price = eventTicker ? await this.options.kalshi.priceAt(eventTicker, row.tokenId, row.targetAt) : null;
            } catch {
              price = null;
            }
            price ??= await store.findNearestKalshiPrice(row.tokenId, row.targetAt, FILL_FALLBACK_WINDOW_MS);
          } else {
            try {
              price = await (this.options.priceAt ?? fetchTokenPriceAt)(row.tokenId, row.targetAt);
            } catch {
              price = null;
            }
            price ??= await store.findNearestFillPrice(row.tokenId, row.targetAt, FILL_FALLBACK_WINDOW_MS);
          }
          await store.setPrice(horizon, row.fillId, price, now);
          if (price !== null) {
            if (horizon === '1h') result.prices1h += 1;
            else result.prices24h += 1;
          }
        }
      });
    }

    await attempt('resolution', async () => {
      const markets = await store.listUnresolvedMarkets(now, RESOLUTION_RETRY_MS, 40);
      if (markets.length === 0) return;
      const resolutions = await (this.options.resolutions ?? fetchMarketResolutions)(markets);
      for (const resolution of resolutions) {
        if (!resolution.resolved) continue;
        const marketId = markets.find((m) => m.toLowerCase() === resolution.conditionId) ?? resolution.conditionId;
        result.resolved += await store.setResolution(marketId, resolution.tokenPrices, resolution.closedAt ?? now);
      }
      await store.markMarketsChecked(markets, now);
    });

    if (this.options.kalshi) {
      const kalshi = this.options.kalshi;
      await attempt('kalshi resolution', async () => {
        const tickers = await store.listUnresolvedMarkets(now, RESOLUTION_RETRY_MS, 100, 'kalshi');
        if (tickers.length === 0) return;
        const settled = await kalshi.settlements(tickers);
        for (const [ticker, price] of Object.entries(settled)) {
          result.resolved += await store.setResolution(ticker, { [ticker]: price }, now);
        }
        await store.markMarketsChecked(tickers, now);
      });
    }

    return result;
  }

  private async likelyMarketMakers(now: Date): Promise<string[]> {
    if (this.mmCache && now.getTime() - this.mmCache.at < MM_CACHE_MS) return this.mmCache.wallets;
    const wallets = await this.options.marketMakers.listLikelyMarketMakers(this.options.marketMakerMinScore);
    this.mmCache = { at: now.getTime(), wallets };
    return wallets;
  }
}
