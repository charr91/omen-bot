import type { AppConfig } from '../config/schema.js';
import type { FillRecord } from '../types/fill.js';
import { SignalId, type TriggeredSignal } from '../types/signal.js';
import type { WalletProfile } from '../types/wallet.js';

interface LumpEntrySignalContext {
  fill: FillRecord;
  wallet: WalletProfile;
  config: Pick<AppConfig, 'detection'>;
}

const LUMP_ENTRY_SCORE = 8;
const LUMP_ENTRY_CONFIDENCE = 0.7;

export function evaluateLumpEntry(context: LumpEntrySignalContext): TriggeredSignal | null {
  if (context.wallet.isWhitelisted) {
    return null;
  }

  const walletTotalVolumeUsd = Number(context.wallet.totalVolumeUsd);
  const fillSizeUsd = Number(context.fill.sizeUsd);
  const priorWalletTotalVolumeUsd = Math.max(0, walletTotalVolumeUsd - fillSizeUsd);
  const priorWalletFillCount = Math.max(0, context.wallet.totalFills - 1);

  if (
    !Number.isFinite(walletTotalVolumeUsd) ||
    !Number.isFinite(fillSizeUsd) ||
    priorWalletFillCount <= 0 ||
    priorWalletTotalVolumeUsd <= 0 ||
    fillSizeUsd < context.config.detection.lumpEntry.minFillUsd
  ) {
    return null;
  }

  const lumpRatio = fillSizeUsd / priorWalletTotalVolumeUsd;
  if (lumpRatio <= context.config.detection.lumpEntry.minLumpRatio) {
    return null;
  }

  const walletAgeHours = context.wallet.activityAgeKnown
    ? Number((context.wallet.ageSeconds / 3600).toFixed(2))
    : 'unknown';

  return {
    signalId: SignalId.LUMP_ENTRY,
    availability: 'LIVE',
    score: LUMP_ENTRY_SCORE,
    confidence: LUMP_ENTRY_CONFIDENCE,
    evidence: [
      {
        field: 'fill_size_usd',
        value: Number(fillSizeUsd.toFixed(2)),
        threshold: `>= ${context.config.detection.lumpEntry.minFillUsd}`,
        description: 'The fill notional must clear the minimum to avoid noise from tiny trades.',
      },
      {
        field: 'prior_wallet_total_volume_usd',
        value: Number(priorWalletTotalVolumeUsd.toFixed(2)),
        threshold: '> 0',
        description: 'The wallet had prior trading volume before this fill, excluding the current fill.',
      },
      {
        field: 'lump_ratio',
        value: Number(lumpRatio.toFixed(2)),
        threshold: `> ${context.config.detection.lumpEntry.minLumpRatio}`,
        description: 'The fill consumes a disproportionate share of the wallet\'s prior lifetime volume.',
      },
      {
        field: 'wallet_age_hours',
        value: walletAgeHours,
        threshold: 'informational',
        description: 'Wallet age is included for operator context when this concentration signal fires.',
      },
    ],
    triggeredAt: new Date(),
  };
}
