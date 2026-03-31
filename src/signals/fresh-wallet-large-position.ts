import type { AppConfig } from '../config/schema.js';
import type { FillRecord } from '../types/fill.js';
import type { MarketInfo } from '../types/market.js';
import { SignalId, type TriggeredSignal } from '../types/signal.js';
import type { WalletProfile } from '../types/wallet.js';
import { calculateLargePositionThreshold } from './market-thresholds.js';

interface FreshWalletSignalContext {
  fill: FillRecord;
  wallet: WalletProfile;
  market: MarketInfo;
  config: Pick<AppConfig, 'detection'>;
}

const CRITICAL_SIGNAL_SCORE = 30;
const ELEVATED_SIGNAL_SCORE = 18;

export function evaluateFreshWalletLargePosition(context: FreshWalletSignalContext): TriggeredSignal | null {
  if (!context.wallet.activityAgeKnown) {
    return null;
  }

  const ageHours = context.wallet.ageSeconds / 3600;
  if (ageHours >= context.config.detection.freshWallet.elevatedAgeHours) {
    return null;
  }

  if (context.wallet.totalTransactions > context.config.detection.freshWallet.maxTransactions) {
    return null;
  }

  const threshold = calculateLargePositionThreshold(context.market, context.config);
  if (threshold.marketDailyVolumeUsd <= 0 || threshold.marketDailyVolumeUsd >= context.config.detection.market.nicheMaxVolume) {
    return null;
  }

  const fillSizeUsd = Number(context.fill.sizeUsd);
  if (!Number.isFinite(fillSizeUsd) || fillSizeUsd < threshold.thresholdUsd) {
    return null;
  }

  const isCritical = ageHours < context.config.detection.freshWallet.criticalAgeHours;
  return {
    signalId: SignalId.FRESH_WALLET_LARGE_POSITION,
    availability: 'LIVE',
    score: isCritical ? CRITICAL_SIGNAL_SCORE : ELEVATED_SIGNAL_SCORE,
    confidence: isCritical ? 0.95 : 0.8,
    evidence: [
      {
        field: 'wallet_age_hours',
        value: Number(ageHours.toFixed(2)),
        threshold: `< ${context.config.detection.freshWallet.elevatedAgeHours}`,
        description: 'Wallet age falls inside the fresh-wallet window.',
      },
      {
        field: 'wallet_total_transactions',
        value: context.wallet.totalTransactions,
        threshold: `<= ${context.config.detection.freshWallet.maxTransactions}`,
        description: 'Wallet transaction count is low enough to count as fresh.',
      },
      {
        field: 'fill_size_usd',
        value: Number(fillSizeUsd.toFixed(2)),
        threshold: Number(threshold.thresholdUsd.toFixed(2)),
        description: 'The fill is large enough to stand out for this market.',
      },
      {
        field: 'market_daily_volume_usd',
        value: Number(threshold.marketDailyVolumeUsd.toFixed(2)),
        threshold: `< ${context.config.detection.market.nicheMaxVolume}`,
        description: 'Fresh-wallet scoring only applies to niche markets with modest daily flow.',
      },
      {
        field: 'threshold_basis',
        value: threshold.dominantThreshold,
        threshold: `${(context.config.detection.market.largePositionVolumePct * 100).toFixed(2)}% daily volume`,
        description: 'Whether the market-relative or absolute size threshold dominated.',
      },
    ],
    triggeredAt: new Date(),
  };
}
