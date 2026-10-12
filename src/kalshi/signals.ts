import { buildVolumeBaseline, detectVolumeSpike } from '../signals/volume-baseline.js';
import type { KalshiTrade } from './client.js';

export type KalshiSignalId =
  | 'KALSHI_BLOCK_TRADE'
  | 'KALSHI_VOLUME_SPIKE'
  | 'KALSHI_BOOK_MOVE'
  | 'CROSS_VENUE_DIVERGENCE';

export interface KalshiSignal {
  signalId: KalshiSignalId;
  ticker: string;
  /** Direction the signal points to: 'yes' = expect the YES price to rise. */
  side: 'yes' | 'no';
  at: Date;
  /** YES price when the signal fired. */
  yesPrice: number;
  /** Reference size for baseline sampling (trade notional), when meaningful. */
  sizeUsd: number | null;
  tradeId: string | null;
  evidence: Record<string, unknown>;
}

export interface KalshiSignalConfig {
  largePrintUsd: number;
  volumeSpikeMinHourUsd: number;
  bookMoveMinCents: number;
  bookMoveWindowMs: number;
  depthPullRatio: number;
  divergenceMinGap: number;
}

export const DEFAULT_KALSHI_SIGNAL_CONFIG: KalshiSignalConfig = {
  largePrintUsd: 10_000,
  volumeSpikeMinHourUsd: 5_000,
  bookMoveMinCents: 8,
  bookMoveWindowMs: 15 * 60_000,
  depthPullRatio: 0.7,
  divergenceMinGap: 0.06,
};

/** Exchange-flagged block trades, or a single print of at least largePrintUsd. */
export function evaluateBlockTrade(trade: KalshiTrade, config: KalshiSignalConfig): KalshiSignal | null {
  if (!trade.isBlockTrade && trade.notionalUsd < config.largePrintUsd) return null;
  return {
    signalId: 'KALSHI_BLOCK_TRADE',
    ticker: trade.ticker,
    side: trade.takerSide,
    at: trade.createdAt,
    yesPrice: trade.yesPrice,
    sizeUsd: trade.notionalUsd,
    tradeId: trade.tradeId,
    evidence: {
      notionalUsd: Number(trade.notionalUsd.toFixed(2)),
      contracts: trade.count,
      isBlockTrade: trade.isBlockTrade,
      threshold: config.largePrintUsd,
    },
  };
}

export interface HourlyVolume {
  hour: Date;
  notionalUsd: number;
  yesNotionalUsd: number;
}

/**
 * Current-hour notional against the ticker's 7-day time-of-day baseline (ported insider-poly-bot logic).
 * Direction is the side that took most of this hour's notional.
 */
export function evaluateVolumeSpike(
  ticker: string,
  history: HourlyVolume[],
  current: HourlyVolume,
  at: Date,
  yesPrice: number | null,
  config: KalshiSignalConfig,
): KalshiSignal | null {
  if (yesPrice === null || current.notionalUsd < config.volumeSpikeMinHourUsd || history.length === 0) return null;
  const from = history.reduce((min, h) => (h.hour < min ? h.hour : min), current.hour);
  const baseline = buildVolumeBaseline(
    history.map((h) => ({ timestamp: h.hour, volumeUsd: h.notionalUsd })),
    from,
    current.hour,
  );
  if (baseline.hours < 24) return null; // need at least a day of history
  const spike = detectVolumeSpike(current.notionalUsd, baseline, at);
  if (!spike.isSpike) return null;
  const yesShare = current.notionalUsd > 0 ? current.yesNotionalUsd / current.notionalUsd : 0.5;
  return {
    signalId: 'KALSHI_VOLUME_SPIKE',
    ticker,
    side: yesShare >= 0.5 ? 'yes' : 'no',
    at,
    yesPrice,
    sizeUsd: null,
    tradeId: null,
    evidence: {
      hourNotionalUsd: Math.round(current.notionalUsd),
      baselineAvgUsd: Math.round(spike.avgVolume),
      multiplier: Number(spike.multiplier.toFixed(2)),
      zScore: Number(spike.zScore.toFixed(2)),
      baselineType: spike.baselineType,
      yesTakerShare: Number(yesShare.toFixed(2)),
    },
  };
}

export interface BookSnapshot {
  at: Date;
  yesBid: number | null;
  yesAsk: number | null;
  bidSize: number;
  askSize: number;
}

function mid(snapshot: BookSnapshot): number | null {
  if (snapshot.yesBid === null || snapshot.yesAsk === null || snapshot.yesAsk <= 0 || snapshot.yesAsk < snapshot.yesBid) {
    return null;
  }
  return (snapshot.yesBid + snapshot.yesAsk) / 2;
}

/**
 * Orderbook move over the window: mid moved >= bookMoveMinCents, or one side's top-of-book size was pulled by
 * >= depthPullRatio while the other side held (pulled bids -> expect down, pulled asks -> expect up).
 */
export function evaluateBookMove(ticker: string, snapshots: BookSnapshot[], config: KalshiSignalConfig): KalshiSignal | null {
  if (snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) => a.at.getTime() - b.at.getTime());
  const latest = sorted[sorted.length - 1]!;
  const windowStart = latest.at.getTime() - config.bookMoveWindowMs;
  const first = sorted.find((s) => s.at.getTime() >= windowStart && mid(s) !== null);
  const latestMid = mid(latest);
  if (!first || first === latest || latestMid === null) return null;
  const firstMid = mid(first)!;
  const moveCents = (latestMid - firstMid) * 100;
  if (Math.abs(moveCents) >= config.bookMoveMinCents) {
    return {
      signalId: 'KALSHI_BOOK_MOVE',
      ticker,
      side: moveCents > 0 ? 'yes' : 'no',
      at: latest.at,
      yesPrice: latestMid,
      sizeUsd: null,
      tradeId: null,
      evidence: { kind: 'mid-move', fromMid: firstMid, toMid: latestMid, moveCents: Number(moveCents.toFixed(1)) },
    };
  }

  const bidPulled = first.bidSize > 0 && latest.bidSize <= first.bidSize * (1 - config.depthPullRatio);
  const askPulled = first.askSize > 0 && latest.askSize <= first.askSize * (1 - config.depthPullRatio);
  if (bidPulled !== askPulled && Math.max(first.bidSize, first.askSize) >= 100) {
    return {
      signalId: 'KALSHI_BOOK_MOVE',
      ticker,
      side: askPulled ? 'yes' : 'no',
      at: latest.at,
      yesPrice: latestMid,
      sizeUsd: null,
      tradeId: null,
      evidence: {
        kind: askPulled ? 'ask-pulled' : 'bid-pulled',
        bidSize: [first.bidSize, latest.bidSize],
        askSize: [first.askSize, latest.askSize],
      },
    };
  }
  return null;
}

/**
 * Polymarket vs Kalshi YES price gap on a hand-mapped pair. The signal is on the Kalshi market and points
 * toward the Polymarket price.
 */
export function evaluateDivergence(
  ticker: string,
  kalshiYes: number | null,
  polymarketYes: number | null,
  at: Date,
  context: { polymarketMarketId: string; recentPolymarketSignals: number },
  config: KalshiSignalConfig,
): KalshiSignal | null {
  if (kalshiYes === null || polymarketYes === null) return null;
  const gap = polymarketYes - kalshiYes;
  if (Math.abs(gap) < config.divergenceMinGap) return null;
  return {
    signalId: 'CROSS_VENUE_DIVERGENCE',
    ticker,
    side: gap > 0 ? 'yes' : 'no',
    at,
    yesPrice: kalshiYes,
    sizeUsd: null,
    tradeId: null,
    evidence: {
      kalshiYes: Number(kalshiYes.toFixed(4)),
      polymarketYes: Number(polymarketYes.toFixed(4)),
      gap: Number(gap.toFixed(4)),
      polymarketMarketId: context.polymarketMarketId,
      recentPolymarketSignals: context.recentPolymarketSignals,
    },
  };
}
