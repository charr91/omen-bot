import type { KalshiClient, KalshiTrade } from './client.js';
import {
  evaluateBlockTrade,
  evaluateBookMove,
  evaluateDivergence,
  evaluateVolumeSpike,
  type KalshiSignal,
  type KalshiSignalConfig,
} from './signals.js';
import type { KalshiStore } from './store.js';

export interface KalshiServiceConfig extends KalshiSignalConfig {
  storeMinNotionalUsd: number;
  maxTradePagesPerPoll: number;
  bookWatchlistSize: number;
  divergenceCooldownMs: number;
  bookMoveCooldownMs: number;
}

export interface KalshiCycleResult {
  trades: number;
  storedTrades: number;
  truncated: boolean;
  signals: Partial<Record<KalshiSignal['signalId'], number>>;
}

const HOUR_MS = 3_600_000;
const SEEN_TTL_MS = 10 * 60_000;
const TRADE_OVERLAP_SEC = 30;

/** Kalshi read-only ingest + signals. No identities exist on Kalshi, so all signals are market-level. */
export class KalshiService {
  private cursorSec: number | null = null;
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly client: Pick<KalshiClient, 'listTradesSince' | 'getMarkets'>,
    private readonly store: KalshiStore,
    private readonly config: KalshiServiceConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Polls public trades since the last cursor (with overlap + id dedupe), aggregates hourly volume, stores large prints. */
  async pollTrades(): Promise<KalshiCycleResult> {
    const now = this.now();
    const minTs = this.cursorSec === null ? Math.floor(now.getTime() / 1000) - 60 : this.cursorSec - TRADE_OVERLAP_SEC;
    const { trades, complete } = await this.client.listTradesSince(minTs, this.config.maxTradePagesPerPoll);
    const fresh = this.dedupe(trades, now);
    await this.store.addHourlyVolume(fresh);
    const large = fresh.filter((t) => t.isBlockTrade || t.notionalUsd >= this.config.storeMinNotionalUsd);
    await this.store.insertTrades(large);

    const result: KalshiCycleResult = { trades: fresh.length, storedTrades: large.length, truncated: !complete, signals: {} };
    for (const trade of large) {
      const signal = evaluateBlockTrade(trade, this.config);
      if (signal && (await this.store.insertSignal(signal, HOUR_MS))) this.count(result, signal);
    }

    const newest = trades.reduce((max, t) => Math.max(max, Math.floor(t.createdAt.getTime() / 1000)), minTs);
    // If the poll was truncated we skip ahead (newest-first paging); the gap is reported as truncated.
    this.cursorSec = Math.max(this.cursorSec ?? 0, newest);
    return result;
  }

  /** Market refresh, volume spikes, orderbook snapshots/moves and cross-venue divergence. */
  async runMarketCycle(): Promise<KalshiCycleResult> {
    const now = this.now();
    const result: KalshiCycleResult = { trades: 0, storedTrades: 0, truncated: false, signals: {} };
    const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);

    const unknown = await this.store.listUnknownActiveTickers(new Date(now.getTime() - 24 * HOUR_MS), this.config.storeMinNotionalUsd, 100);
    if (unknown.length > 0) await this.store.upsertMarkets(await this.client.getMarkets(unknown));

    const hot = await this.store.listHotTickers(hour, this.config.volumeSpikeMinHourUsd, this.config.bookWatchlistSize);
    const mappings = await this.store.listMappings();
    const watch = [...new Set([...mappings.map((m) => m.kalshiTicker), ...hot.map((h) => h.ticker)])].slice(
      0,
      this.config.bookWatchlistSize + mappings.length,
    );
    const markets = watch.length > 0 ? await this.client.getMarkets(watch) : [];
    await this.store.upsertMarkets(markets);
    await this.store.insertSnapshots(
      markets.map((m) => ({ ticker: m.ticker, at: now, yesBid: m.yesBid, yesAsk: m.yesAsk, bidSize: m.yesBidSize, askSize: m.yesAskSize })),
    );
    const yesPriceOf = new Map(
      markets.map((m) => [
        m.ticker,
        m.yesBid !== null && m.yesAsk !== null && m.yesAsk > 0 && m.yesAsk >= m.yesBid ? (m.yesBid + m.yesAsk) / 2 : m.lastPrice,
      ]),
    );

    for (const current of hot) {
      const history = await this.store.listHourlyHistory(current.ticker, new Date(hour.getTime() - 7 * 24 * HOUR_MS), hour);
      const signal = evaluateVolumeSpike(current.ticker, history, current, now, yesPriceOf.get(current.ticker) ?? null, this.config);
      if (signal && (await this.store.insertSignal(signal, HOUR_MS))) this.count(result, signal);
    }

    for (const market of markets) {
      const snapshots = await this.store.listSnapshots(market.ticker, new Date(now.getTime() - this.config.bookMoveWindowMs));
      const signal = evaluateBookMove(market.ticker, snapshots, this.config);
      if (signal && (await this.store.insertSignal(signal, this.config.bookMoveCooldownMs))) this.count(result, signal);
    }

    for (const mapping of mappings) {
      const pm = await this.store.getPolymarketYesPrice(mapping.polymarketMarketId, new Date(now.getTime() - 30 * 60_000));
      const polymarketYes = pm === null ? null : mapping.invert ? 1 - pm : pm;
      const signal = evaluateDivergence(
        mapping.kalshiTicker,
        yesPriceOf.get(mapping.kalshiTicker) ?? null,
        polymarketYes,
        now,
        {
          polymarketMarketId: mapping.polymarketMarketId,
          recentPolymarketSignals: await this.store.countRecentPolymarketSignals(mapping.polymarketMarketId, new Date(now.getTime() - HOUR_MS)),
        },
        this.config,
      );
      if (signal && (await this.store.insertSignal(signal, this.config.divergenceCooldownMs))) this.count(result, signal);
    }

    if (now.getUTCMinutes() === 0) await this.store.prune(now);
    return result;
  }

  private dedupe(trades: KalshiTrade[], now: Date): KalshiTrade[] {
    const cutoff = now.getTime() - SEEN_TTL_MS;
    for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    const fresh: KalshiTrade[] = [];
    for (const trade of trades) {
      if (this.seen.has(trade.tradeId)) continue;
      this.seen.set(trade.tradeId, now.getTime());
      fresh.push(trade);
    }
    return fresh;
  }

  private count(result: KalshiCycleResult, signal: KalshiSignal): void {
    result.signals[signal.signalId] = (result.signals[signal.signalId] ?? 0) + 1;
  }
}
