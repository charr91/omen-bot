import type { AppConfig } from '../config/schema.js';
import type { MarketInfo } from '../types/market.js';

export interface LargePositionThreshold {
  marketDailyVolumeUsd: number;
  relativeThresholdUsd: number;
  absoluteThresholdUsd: number;
  thresholdUsd: number;
  dominantThreshold: 'absolute' | 'relative';
}

export function calculateLargePositionThreshold(
  market: MarketInfo,
  config: Pick<AppConfig, 'detection'>,
): LargePositionThreshold {
  const marketDailyVolumeUsd = Number(market.dailyVolumeUsd);
  const relativeThresholdUsd =
    Number.isFinite(marketDailyVolumeUsd) && marketDailyVolumeUsd > 0
      ? marketDailyVolumeUsd * config.detection.market.largePositionVolumePct
      : 0;
  const absoluteThresholdUsd = config.detection.market.largePositionMinUsd;
  const thresholdUsd = Math.max(absoluteThresholdUsd, relativeThresholdUsd);

  return {
    marketDailyVolumeUsd: Number.isFinite(marketDailyVolumeUsd) ? marketDailyVolumeUsd : 0,
    relativeThresholdUsd,
    absoluteThresholdUsd,
    thresholdUsd,
    dominantThreshold: relativeThresholdUsd > absoluteThresholdUsd ? 'relative' : 'absolute',
  };
}
