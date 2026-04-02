import type { AppConfig } from '../config/schema.js';
import type { FillRecord } from '../types/fill.js';
import type { MarketInfo } from '../types/market.js';
import { SignalId, type TriggeredSignal } from '../types/signal.js';

interface NicheMarketEntrySignalContext {
  fill: FillRecord;
  market: MarketInfo;
  config: Pick<AppConfig, 'detection'>;
}

const NICHE_MARKET_ENTRY_SCORE = 7;
const NICHE_MARKET_ENTRY_CONFIDENCE = 0.6;

export function evaluateNicheMarketEntry(context: NicheMarketEntrySignalContext): TriggeredSignal | null {
  const marketDailyVolumeUsd = Number(context.market.dailyVolumeUsd);
  const fillSizeUsd = Number(context.fill.sizeUsd);

  if (!Number.isFinite(marketDailyVolumeUsd) || !Number.isFinite(fillSizeUsd)) {
    return null;
  }

  if (marketDailyVolumeUsd >= context.config.detection.nicheMarketEntry.maxMarketVolumeUsd) {
    return null;
  }

  if (fillSizeUsd < context.config.detection.nicheMarketEntry.minFillUsd) {
    return null;
  }

  return {
    signalId: SignalId.NICHE_MARKET_ENTRY,
    availability: 'LIVE',
    score: NICHE_MARKET_ENTRY_SCORE,
    confidence: NICHE_MARKET_ENTRY_CONFIDENCE,
    evidence: [
      {
        field: 'market_daily_volume_usd',
        value: Number(marketDailyVolumeUsd.toFixed(2)),
        threshold: `< ${context.config.detection.nicheMarketEntry.maxMarketVolumeUsd}`,
        description: 'The market is still niche enough for this entry to stand out.',
      },
      {
        field: 'fill_size_usd',
        value: Number(fillSizeUsd.toFixed(2)),
        threshold: `>= ${context.config.detection.nicheMarketEntry.minFillUsd}`,
        description: 'The fill is large enough to matter on a niche market.',
      },
    ],
    triggeredAt: new Date(),
  };
}
