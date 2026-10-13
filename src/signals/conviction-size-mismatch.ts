import type { AppConfig } from '../config/schema.js';
import type { FillRecord } from '../types/fill.js';
import { effectivePosition } from './effective-position.js';
import { SignalId, type TriggeredSignal } from '../types/signal.js';
import type { WalletProfile } from '../types/wallet.js';

interface ConvictionSizeMismatchSignalContext {
  fill: FillRecord;
  wallet: WalletProfile;
  config: Pick<AppConfig, 'detection'>;
}

const CONVICTION_SIZE_MISMATCH_SCORE = 14;
const CONVICTION_SIZE_MISMATCH_CONFIDENCE = 0.8;

export function evaluateConvictionSizeMismatch(
  context: ConvictionSizeMismatchSignalContext,
): TriggeredSignal | null {
  if (context.wallet.fundingClusterId !== null) {
    return null;
  }

  const walletTotalVolumeUsd = Number(context.wallet.totalVolumeUsd);
  // Effective side and price: a SELL of YES at 0.24 is a NO position at 0.76 (not a longshot), and the stake at
  // risk is shares x 0.76.
  const position = effectivePosition(context.fill);
  if (position === null) {
    return null;
  }
  const fillSizeUsd = position.stakeUsd;
  const fillPrice = position.price;
  // Wallet volume is stored as fill notional, so remove this fill's notional (not its effective stake).
  const priorWalletTotalVolumeUsd = Math.max(0, walletTotalVolumeUsd - Number(context.fill.sizeUsd));
  const priorWalletFillCount = Math.max(0, context.wallet.totalFills - 1);
  if (
    !Number.isFinite(walletTotalVolumeUsd) ||
    !Number.isFinite(fillSizeUsd) ||
    !Number.isFinite(fillPrice) ||
    priorWalletTotalVolumeUsd <= 0 ||
    priorWalletFillCount <= 0 ||
    fillSizeUsd < context.config.detection.convictionSizeMismatch.minFillUsd ||
    priorWalletTotalVolumeUsd >= context.config.detection.convictionSizeMismatch.maxWalletTotalVolumeUsd ||
    fillPrice >= context.config.detection.convictionSizeMismatch.longshotMaxPrice
  ) {
    return null;
  }

  const fillToWalletVolumeRatio = fillSizeUsd / priorWalletTotalVolumeUsd;
  if (fillToWalletVolumeRatio <= context.config.detection.convictionSizeMismatch.minFillToWalletVolumeRatio) {
    return null;
  }

  const walletAgeHours = context.wallet.activityAgeKnown
    ? Number((context.wallet.ageSeconds / 3600).toFixed(2))
    : 'unknown';

  return {
    signalId: SignalId.CONVICTION_SIZE_MISMATCH,
    availability: 'LIVE',
    score: CONVICTION_SIZE_MISMATCH_SCORE,
    confidence: CONVICTION_SIZE_MISMATCH_CONFIDENCE,
    evidence: [
      {
        field: 'prior_wallet_total_volume_usd',
        value: Number(priorWalletTotalVolumeUsd.toFixed(2)),
        threshold: `< ${context.config.detection.convictionSizeMismatch.maxWalletTotalVolumeUsd}`,
        description: 'The wallet was still small by lifetime deployed volume before this fill landed.',
      },
      {
        field: 'fill_size_usd',
        value: Number(fillSizeUsd.toFixed(2)),
        threshold: `>= ${context.config.detection.convictionSizeMismatch.minFillUsd}`,
        description: 'Tiny fills are excluded so only meaningful conviction bets qualify.',
      },
      {
        field: 'fill_size_vs_prior_volume_usd',
        value: Number(fillSizeUsd.toFixed(2)),
        threshold: `> ${(context.config.detection.convictionSizeMismatch.minFillToWalletVolumeRatio * 100).toFixed(0)}% wallet lifetime volume`,
        description: "The trade is outsized relative to the wallet's prior trading history, excluding the current fill.",
      },
      {
        field: 'fill_to_prior_wallet_volume_ratio',
        value: Number(fillToWalletVolumeRatio.toFixed(2)),
        threshold: `> ${context.config.detection.convictionSizeMismatch.minFillToWalletVolumeRatio}`,
        description: "The fill consumes an unusually large share of the wallet's prior lifetime volume.",
      },
      {
        field: 'fill_price',
        value: Number(fillPrice.toFixed(4)),
        threshold: `< ${context.config.detection.convictionSizeMismatch.longshotMaxPrice}`,
        description: 'The wallet is taking a large swing on longshot pricing (effective price of the side it now holds).',
      },
      {
        field: 'effective_outcome',
        value: position.outcome,
        threshold: 'informational',
        description: 'The outcome the trader is effectively long after this fill (a SELL of YES is long NO).',
      },
      {
        field: 'wallet_age_hours',
        value: walletAgeHours,
        threshold: 'informational',
        description: 'Wallet age is included for operator context when this mismatch fires.',
      },
    ],
    triggeredAt: new Date(),
  };
}
