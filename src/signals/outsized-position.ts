import type { AppConfig } from '../config/schema.js';
import type { FillRecord } from '../types/fill.js';
import type { MarketInfo } from '../types/market.js';
import { SignalId, type TriggeredSignal } from '../types/signal.js';
import { calculateLargePositionThreshold } from './market-thresholds.js';

interface OutsizedPositionSignalContext {
  fill: FillRecord;
  market: MarketInfo;
  config: Pick<AppConfig, 'detection'>;
}

const OUTSIZED_POSITION_SCORE = 12;
const OUTSIZED_POSITION_CONFIDENCE = 0.8;

export function evaluateOutsizedPosition(context: OutsizedPositionSignalContext): TriggeredSignal | null {
  const fillSizeUsd = Number(context.fill.sizeUsd);
  const threshold = calculateLargePositionThreshold(context.market, context.config);

  if (!Number.isFinite(fillSizeUsd) || fillSizeUsd < threshold.thresholdUsd) {
    return null;
  }

  return {
    signalId: SignalId.OUTSIZED_POSITION,
    availability: 'LIVE',
    score: OUTSIZED_POSITION_SCORE,
    confidence: OUTSIZED_POSITION_CONFIDENCE,
    evidence: [
      {
        field: 'fill_size_usd',
        value: Number(fillSizeUsd.toFixed(2)),
        threshold: Number(threshold.thresholdUsd.toFixed(2)),
        description: 'Single-fill notional compared against the market-relative outsized threshold.',
      },
      {
        field: 'market_daily_volume_usd',
        value: Number(threshold.marketDailyVolumeUsd.toFixed(2)),
        threshold: `${(context.config.detection.market.largePositionVolumePct * 100).toFixed(2)}% daily volume`,
        description: 'Twenty-four hour market volume used to scale the outsized threshold.',
      },
      {
        field: 'threshold_basis',
        value: threshold.dominantThreshold,
        threshold: `${Number(threshold.absoluteThresholdUsd.toFixed(2))} absolute floor`,
        description: 'Whether the relative or absolute threshold dominated for this fill.',
      },
    ],
    triggeredAt: new Date(),
  };
}
