import type { AppConfig } from '../config/schema.js';
import { parseTradeToFill } from '../ingestion/polymarket-client.js';
import { deriveWalletAge } from '../profiling/wallet-age.js';
import { effectivePosition } from '../signals/effective-position.js';
import { isSignalDeliverable } from '../signals/delivery.js';
import { computeDeliverableLiveScore, evaluateLiveSignals, marketExclusionConfig } from '../signals/evaluate-live-signals.js';
import { classifyMarketExclusion } from '../signals/market-exclusion.js';
import { calculateMarketMakerScore } from '../signals/market-maker.js';
import { deriveAlertTier } from '../signals/scoring.js';
import type { FillRecord } from '../types/fill.js';
import type { MarketInfo } from '../types/market.js';
import { SignalId, type AlertTier } from '../types/signal.js';
import type { WalletChainProfile, WalletProfile } from '../types/wallet.js';
import type { BacktestCase } from './cases.js';
import type { RawMarket, RawTrade, WalletHistory } from './data.js';

export type ReplayConfig = Pick<AppConfig, 'detection' | 'alerts' | 'marketMaker'> & Partial<Pick<AppConfig, 'filters'>>;

/**
 * Signals whose own alerts can reach Telegram under `config`: not score-only, not shadow. SYBIL_CLUSTER is excluded
 * when muted, and is never evaluated offline anyway (needs Alchemy funding graphs).
 */
export function deliveredSignalIds(config: ReplayConfig): SignalId[] {
  const scoreOnly = new Set(config.detection.scoreOnlySignals ?? []);
  const longshot = config.detection.freshWalletLongshot;
  return [SignalId.FRESH_WALLET_LARGE_POSITION, SignalId.CONVICTION_SIZE_MISMATCH, SignalId.FRESH_WALLET_LONGSHOT, SignalId.NICHE_MARKET_ENTRY, SignalId.OUTSIZED_POSITION, SignalId.LUMP_ENTRY, SignalId.SYBIL_CLUSTER].filter((id) => {
    if (scoreOnly.has(id)) return false;
    if (id === SignalId.FRESH_WALLET_LONGSHOT) return Boolean(longshot?.enabled && longshot.deliver);
    if (id === SignalId.SYBIL_CLUSTER) return false;
    return true;
  });
}

/** The lowest per-fill minimum of any live signal that can run offline (conviction stake, $250). */
export function candidateMinUsd(config: ReplayConfig): number {
  const d = config.detection;
  return Math.min(d.convictionSizeMismatch.minFillUsd, d.lumpEntry.minFillUsd, d.nicheMarketEntry.minFillUsd, d.market.largePositionMinUsd);
}

export function fillExposureUsd(trade: Pick<RawTrade, 'size' | 'price'>): number {
  // Notional, or the effective stake when a SELL flips to the other side at 1 - price.
  return Math.max(trade.size * trade.price, trade.size * (1 - trade.price));
}

export const TIER_RANK: Record<AlertTier, number> = { CLEAN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export interface ReplayAlert {
  timestamp: number;
  wallet: string;
  name: string | null;
  effectiveOutcome: 'YES' | 'NO';
  effectivePrice: number;
  sizeUsd: number;
  marketDailyVolumeUsd: number;
  walletAgeHours: number | null;
  priorWalletVolumeUsd: number | null;
  score: number;
  tier: AlertTier;
  signals: SignalId[];
  /** Signals whose own alert may be delivered (not score-only, not shadow); empty = nothing reaches Telegram. */
  deliverableSignals: SignalId[];
  winningSide: boolean;
  /** False when the live dedup (same wallet+market inside the cooldown, score not +N) would have held it back. */
  delivered: boolean;
  reportedWallet: boolean;
  suppressedAsMarketMaker: boolean;
}

export interface ReplayResult {
  caseId: string;
  tradesInWindow: number;
  volumeInWindowUsd: number;
  candidatesEvaluated: number;
  walletsProfiled: number;
  walletsUnprofiled: number;
  excludedMarket: boolean;
  alerts: ReplayAlert[];
  /** Fills by wallets named in reporting, whether or not they alerted. */
  /**
   * What-if probe (not a live signal): fills where a wallet < 24h old with <= max_txns activity takes a longshot
   * (effective price < conviction longshot_max_price) with stake >= $1k, regardless of market size or prior history.
   */
  probeFills: { timestamp: number; stakeUsd: number; effectivePrice: number; winningSide: boolean; ageHours: number }[];
  reportedFills: { timestamp: number; name: string; effectiveOutcome: 'YES' | 'NO'; sizeUsd: number; tier: AlertTier; signals: SignalId[] }[];
  /**
   * Every candidate fill with >= 1 live signal (any tier, market makers removed), as live enrolls signal fills in
   * trade_outcomes. `delivered` = the live dedup would have let this fill's alert through.
   */
  signalFills: GradedFill[];
  /** Candidate fills (>= the lowest signal minimum) with no signal and no market-maker wallet: the move baseline. */
  baselineFills: GradedFill[];
}

/** A fill as graded by `omen outcomes`: raw token side/price (BUY profits when the token rises). */
export interface GradedFill {
  timestamp: number;
  asset: string;
  /** Token outcome label of the traded asset ('YES' | 'NO'). */
  tokenOutcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  /** Fill notional and effective (position) price, for threshold what-ifs. */
  sizeUsd?: number;
  effectivePrice?: number;
  /** Wallet age (h) and prior Polymarket volume at the fill, null when unknown. */
  walletAgeHours?: number | null;
  walletPriorVolumeUsd?: number | null;
  marketDailyVolumeUsd?: number;
  signals?: SignalId[];
  deliverableSignals?: SignalId[];
  tier?: AlertTier;
  delivered?: boolean;
  winningSide?: boolean;
}

interface WalletPointInTime {
  profile: WalletProfile;
  marketMakerScore: number;
  priorVolumeUsd: number | null;
}

/** Wallet state just before `fill`, rebuilt from its Polymarket activity (proxy for omen's DB + Alchemy profile). */
/**
 * Two activity pages per wallet: `pre` ends at the wallet's first candidate fill in the window (its history before
 * entering), `recent` ends at the news. A fill's prior history is complete when it is the first candidate fill, or
 * when the two pages leave no gap. Otherwise it is unknown and the wallet gets the conservative profile.
 */
export interface WalletHistoryPair {
  firstFillTs: number;
  pre: WalletHistory;
  recent: WalletHistory;
}

export function resolveHistory(
  history: WalletHistoryPair | undefined,
  t: number,
): { prior: WalletHistory['events']; ageKnown: boolean } | null {
  if (!history) return null;
  const pre = history.pre.events.filter((e) => e.timestamp < Math.min(t, history.firstFillTs));
  const recentOldest = history.recent.events.length ? Math.min(...history.recent.events.map((e) => e.timestamp)) : Infinity;
  const gap = history.recent.truncated && recentOldest > history.firstFillTs;
  if (t > history.firstFillTs && gap) return null;
  const seen = new Set<string>();
  const prior: WalletHistory['events'] = [];
  for (const e of [...pre, ...history.recent.events.filter((x) => x.timestamp < t && x.timestamp >= history.firstFillTs)]) {
    const k = `${e.timestamp}:${e.conditionId}:${e.type}:${e.size}:${e.side}`;
    if (!seen.has(k)) {
      seen.add(k);
      prior.push(e);
    }
  }
  if (history.pre.truncated && pre.length === 0) return null;
  return { prior, ageKnown: !history.pre.truncated };
}

export function walletAt(fill: FillRecord, history: WalletHistoryPair | undefined, config: ReplayConfig): WalletPointInTime {
  const t = Math.floor(fill.timestamp.getTime() / 1000);
  const fillUsd = Number(fill.sizeUsd);
  const base = (over: Partial<WalletProfile>): WalletProfile => ({
    address: fill.walletAddress,
    ageSeconds: 0,
    activityAgeKnown: false,
    totalTransactions: 1,
    isContract: true,
    controllerAddress: null,
    freshnessAgeSeconds: 0,
    freshnessActivityAgeKnown: false,
    freshnessTotalTransactions: 1,
    firstSeenAt: fill.timestamp,
    lastActiveAt: fill.timestamp,
    totalMarkets: 1,
    totalFills: 1,
    totalVolumeUsd: String(fillUsd),
    fundingClusterId: null,
    liveSuspicionScore: 0,
    liveTier: 'CLEAN',
    isWhitelisted: false,
    ...over,
  });

  const resolved = resolveHistory(history, t);
  if (resolved === null) {
    return { profile: base({}), marketMakerScore: 0, priorVolumeUsd: null };
  }
  const { prior, ageKnown } = resolved;

  const priorTrades = prior.filter((e) => e.type === 'TRADE');
  const priorVolumeUsd = priorTrades.reduce((s, e) => s + (Number(e.usdcSize) || 0), 0);
  const markets = new Set(priorTrades.map((e) => e.conditionId));
  markets.add(fill.marketId);
  const firstPrior = prior.length > 0 ? Math.min(...prior.map((e) => e.timestamp)) : t;
  const chain: WalletChainProfile = !ageKnown
    ? {
        ageSeconds: 0,
        activityAgeKnown: false,
        totalTransactions: prior.length + 1,
        isContract: true,
        controllerAddress: null,
        freshnessAgeSeconds: 0,
        freshnessActivityAgeKnown: false,
        freshnessTotalTransactions: prior.length + 1,
        firstActivityAt: null,
      }
    : {
        ageSeconds: t - firstPrior,
        activityAgeKnown: true,
        totalTransactions: prior.length + 1,
        isContract: true,
        controllerAddress: null,
        freshnessAgeSeconds: t - firstPrior,
        freshnessActivityAgeKnown: true,
        freshnessTotalTransactions: prior.length + 1,
        firstActivityAt: new Date(firstPrior * 1000),
      };
  const totalFills = priorTrades.length + 1;
  const age = deriveWalletAge({
    chain,
    fundingFirstAt: null,
    fundingInboundCount: 0,
    firstSeenAt: new Date(firstPrior * 1000),
    priorFills: totalFills,
    now: fill.timestamp,
    freshWindowHours: config.detection.freshWallet.elevatedAgeHours,
  });

  let buy = 0;
  let sell = 0;
  for (const e of priorTrades) {
    if (e.side === 'SELL') sell += Number(e.usdcSize) || 0;
    else buy += Number(e.usdcSize) || 0;
  }
  if (fill.side === 'SELL') sell += fillUsd;
  else buy += fillUsd;
  const marketMakerScore = calculateMarketMakerScore({
    tradeCount: totalFills,
    buyVolumeUsd: buy,
    sellVolumeUsd: sell,
    marketsCount: markets.size,
    firstSeenAt: new Date(firstPrior * 1000),
    lastSeenAt: fill.timestamp,
  });

  return {
    profile: base({
      ageSeconds: age.ageSeconds,
      activityAgeKnown: age.activityAgeKnown,
      totalTransactions: age.totalTransactions,
      freshnessAgeSeconds: age.freshnessAgeSeconds,
      freshnessActivityAgeKnown: age.freshnessActivityAgeKnown,
      freshnessTotalTransactions: age.freshnessTotalTransactions,
      firstSeenAt: age.firstActivityAt ?? new Date(firstPrior * 1000),
      totalMarkets: markets.size,
      totalFills,
      totalVolumeUsd: String(priorVolumeUsd + fillUsd),
    }),
    marketMakerScore,
    priorVolumeUsd,
  };
}

/**
 * Replay one market's tape through omen's live signal + scoring path (evaluateLiveSignals, composite score, tier,
 * market-maker filter, dedup). SYBIL_CLUSTER needs Alchemy funding graphs and is not evaluated (cluster = null).
 */
export function replayCase(input: {
  testCase: BacktestCase;
  market: RawMarket;
  /** Taker trades from windowStart - 24h through newsAt, oldest first. */
  trades: RawTrade[];
  histories: Map<string, WalletHistoryPair>;
  config: ReplayConfig;
}): ReplayResult {
  const { testCase, config } = input;
  const windowStart = Date.parse(testCase.windowStart) / 1000;
  const newsAt = Date.parse(testCase.newsAt) / 1000;
  const reported = new Set((testCase.reportedWallets ?? []).map((n) => n.toLowerCase()));
  const minUsd = candidateMinUsd(config);

  const market: MarketInfo = {
    id: input.market.conditionId,
    eventSlug: input.market.eventSlug,
    question: input.market.question,
    marketSlug: input.market.slug,
    dailyVolumeUsd: '0',
    dailyVolumeSource: 'trades',
    category: input.market.category ?? null,
    tags: input.market.tags ?? [],
    sportsMarketType: input.market.sportsMarketType ?? null,
    volumeUsd: String(input.market.volume),
    liquidityUsd: '0',
  };

  const trades = input.trades;
  const notional = trades.map((t) => t.size * t.price);
  let lo = 0;
  let rolling = 0;
  let hi = 0;

  const result: ReplayResult = {
    caseId: testCase.id,
    tradesInWindow: 0,
    volumeInWindowUsd: 0,
    candidatesEvaluated: 0,
    walletsProfiled: input.histories.size,
    walletsUnprofiled: 0,
    excludedMarket: classifyMarketExclusion(market, marketExclusionConfig(config)) !== null,
    alerts: [],
    probeFills: [],
    reportedFills: [],
    signalFills: [],
    baselineFills: [],
  };
  const unprofiled = new Set<string>();
  const lastDelivered = new Map<string, { at: number; score: number }>();

  for (let i = 0; i < trades.length; i += 1) {
    const trade = trades[i]!;
    if (trade.timestamp < windowStart || trade.timestamp >= newsAt) continue;
    // 24h tape volume strictly before this fill (omen's MarketVolumeRefiner window).
    while (hi < trades.length && trades[hi]!.timestamp < trade.timestamp) rolling += notional[hi++]!;
    while (lo < hi && trades[lo]!.timestamp < trade.timestamp - 86_400) rolling -= notional[lo++]!;
    result.tradesInWindow += 1;
    result.volumeInWindowUsd += notional[i]!;

    const name = trade.name || trade.pseudonym || null;
    const isReported = [trade.name, trade.pseudonym].some((n) => n && reported.has(n.toLowerCase()));
    if (fillExposureUsd(trade) < minUsd && !isReported) continue;

    const parsed = parseTradeToFill(trade as unknown as Parameters<typeof parseTradeToFill>[0]);
    if (parsed.kind !== 'ok') continue;
    const fill: FillRecord = { ...parsed.fill, analyzed: false, createdAt: parsed.fill.timestamp };
    const history = input.histories.get(fill.walletAddress.toLowerCase());
    if (!history) unprofiled.add(fill.walletAddress.toLowerCase());
    const point = walletAt(fill, history, config);
    const marketAt: MarketInfo = { ...market, dailyVolumeUsd: rolling.toFixed(2) };
    result.candidatesEvaluated += 1;

    const evaluated = evaluateLiveSignals({ fill, wallet: point.profile, market: marketAt, config, cluster: null });
    const isMm = evaluated.length > 0 && config.marketMaker.filterEnabled && point.marketMakerScore >= config.marketMaker.minScore;
    const signals = isMm ? [] : evaluated;
    // Shadow-mode signals (deliver = false) are not delivered live, so they do not count toward the delivered tier.
    const score = computeDeliverableLiveScore(signals);
    const tier = deriveAlertTier(score, config);
    const position = effectivePosition(fill);
    const effectiveOutcome = position?.outcome ?? fill.outcome;
    const deliverable = signals.filter((s) => isSignalDeliverable(s)).map((s) => s.signalId);
    const graded: GradedFill = {
      timestamp: trade.timestamp,
      asset: trade.asset,
      tokenOutcome: fill.outcome,
      side: fill.side,
      price: Number(fill.price),
      sizeUsd: Number(fill.sizeUsd),
      effectivePrice: position?.price ?? Number(fill.price),
      walletAgeHours: point.profile.activityAgeKnown ? point.profile.ageSeconds / 3600 : null,
      walletPriorVolumeUsd: point.priorVolumeUsd,
      marketDailyVolumeUsd: rolling,
    };

    const ageHours = point.profile.activityAgeKnown ? point.profile.ageSeconds / 3600 : null;
    if (
      position &&
      ageHours !== null &&
      ageHours < config.detection.freshWallet.criticalAgeHours &&
      point.profile.totalTransactions <= config.detection.freshWallet.maxTransactions &&
      position.price < config.detection.convictionSizeMismatch.longshotMaxPrice &&
      position.stakeUsd >= 1_000
    ) {
      result.probeFills.push({ timestamp: trade.timestamp, stakeUsd: position.stakeUsd, effectivePrice: position.price, winningSide: position.outcome === testCase.winningOutcome, ageHours });
    }

    if (isReported) {
      result.reportedFills.push({
        timestamp: trade.timestamp,
        name: name ?? fill.walletAddress,
        effectiveOutcome,
        sizeUsd: Number(fill.sizeUsd),
        tier,
        signals: signals.map((s) => s.signalId),
      });
    }
    const walletIsMm = config.marketMaker.filterEnabled && point.marketMakerScore >= config.marketMaker.minScore;
    if (evaluated.length === 0 && !walletIsMm) result.baselineFills.push(graded);
    if (tier === 'CLEAN' && !(isMm && evaluated.length > 0)) {
      if (signals.length > 0) {
        result.signalFills.push({ ...graded, signals: signals.map((s) => s.signalId), deliverableSignals: deliverable, tier, delivered: false, winningSide: effectiveOutcome === testCase.winningOutcome });
      }
      continue;
    }

    const key = `${fill.walletAddress}:${fill.marketId}`;
    const last = lastDelivered.get(key);
    const delivered =
      tier !== 'CLEAN' &&
      (!last || trade.timestamp - last.at >= config.alerts.dedupCooldownMs / 1000 || score >= last.score + config.alerts.dedupScoreIncrease);
    if (delivered) lastDelivered.set(key, { at: trade.timestamp, score });
    if (signals.length > 0) {
      result.signalFills.push({ ...graded, signals: signals.map((s) => s.signalId), deliverableSignals: deliverable, tier, delivered, winningSide: effectiveOutcome === testCase.winningOutcome });
    }

    result.alerts.push({
      timestamp: trade.timestamp,
      wallet: fill.walletAddress,
      name,
      effectiveOutcome,
      effectivePrice: position?.price ?? Number(fill.price),
      sizeUsd: Number(fill.sizeUsd),
      marketDailyVolumeUsd: rolling,
      walletAgeHours: point.profile.activityAgeKnown ? point.profile.ageSeconds / 3600 : null,
      priorWalletVolumeUsd: point.priorVolumeUsd,
      score,
      tier,
      signals: (isMm ? evaluated : signals).map((s) => s.signalId),
      deliverableSignals: deliverable,
      winningSide: effectiveOutcome === testCase.winningOutcome,
      delivered,
      reportedWallet: isReported,
      suppressedAsMarketMaker: isMm,
    });
  }
  result.walletsUnprofiled = unprofiled.size;
  return result;
}

/** Wallets worth profiling: the ones with a fill that clears the lowest offline signal minimum, largest first. */
export function candidateWallets(testCase: BacktestCase, trades: RawTrade[], config: ReplayConfig): { wallet: string; firstFillTs: number }[] {
  const windowStart = Date.parse(testCase.windowStart) / 1000;
  const newsAt = Date.parse(testCase.newsAt) / 1000;
  const reported = new Set((testCase.reportedWallets ?? []).map((n) => n.toLowerCase()));
  const minUsd = candidateMinUsd(config);
  const best = new Map<string, number>();
  const first = new Map<string, number>();
  for (const t of trades) {
    if (t.timestamp < windowStart || t.timestamp >= newsAt) continue;
    const isReported = [t.name, t.pseudonym].some((n) => n && reported.has(n.toLowerCase()));
    const usd = fillExposureUsd(t);
    if (usd < minUsd && !isReported) continue;
    const w = t.proxyWallet.toLowerCase();
    best.set(w, Math.max(best.get(w) ?? 0, isReported ? Number.MAX_SAFE_INTEGER : usd));
    first.set(w, Math.min(first.get(w) ?? Infinity, t.timestamp));
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([wallet]) => ({ wallet, firstFillTs: first.get(wallet)! }));
}
