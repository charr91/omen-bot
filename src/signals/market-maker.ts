/**
 * Market-maker likelihood score (0-100), ported from insider-poly-bot persistence/whale_tracker.py
 * (calculate_mm_score + MarketMakerThresholds). Score >= 70 = likely market maker.
 *
 * Factors: trade frequency (30), buy/sell balance (40), market diversity (20), days active (10).
 */
export const MARKET_MAKER_THRESHOLDS = {
  highFrequencyTrades: 100,
  mediumFrequencyTrades: 50,
  lowFrequencyTrades: 25,
  tightRatioMin: 0.45,
  tightRatioMax: 0.55,
  looseRatioMin: 0.4,
  looseRatioMax: 0.6,
  manyMarkets: 10,
  severalMarkets: 5,
  longActivityDays: 7,
  mediumActivityDays: 3,
  classificationThreshold: 70,
} as const;

export interface MarketMakerActivity {
  tradeCount: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  marketsCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export function calculateMarketMakerScore(activity: MarketMakerActivity): number {
  const t = MARKET_MAKER_THRESHOLDS;
  let score = 0;

  if (activity.tradeCount >= t.highFrequencyTrades) score += 30;
  else if (activity.tradeCount >= t.mediumFrequencyTrades) score += 20;
  else if (activity.tradeCount >= t.lowFrequencyTrades) score += 10;

  const totalVolume = activity.buyVolumeUsd + activity.sellVolumeUsd;
  if (totalVolume > 0) {
    const buyRatio = activity.buyVolumeUsd / totalVolume;
    if (buyRatio >= t.tightRatioMin && buyRatio <= t.tightRatioMax) score += 40;
    else if (buyRatio >= t.looseRatioMin && buyRatio <= t.looseRatioMax) score += 20;
  }

  if (activity.marketsCount >= t.manyMarkets) score += 20;
  else if (activity.marketsCount >= t.severalMarkets) score += 10;

  const daysActive = Math.floor((activity.lastSeenAt.getTime() - activity.firstSeenAt.getTime()) / 86_400_000);
  if (daysActive >= t.longActivityDays) score += 10;
  else if (daysActive >= t.mediumActivityDays) score += 5;

  return Math.min(score, 100);
}

export function isLikelyMarketMaker(score: number, minScore: number = MARKET_MAKER_THRESHOLDS.classificationThreshold): boolean {
  return score >= minScore;
}
