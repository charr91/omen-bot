import type { AlertTier, TriggeredSignal } from './signal.js';

export type PromotedAlertTier = Exclude<AlertTier, 'CLEAN'>;

export interface SignalPreview {
  fillId: string;
  walletAddress: string;
  marketId: string;
  marketQuestion: string;
  walletLiveScore: number;
  walletLiveTier: AlertTier;
  signal: TriggeredSignal;
  dryRun: boolean;
}

export interface PromotedAlert extends SignalPreview {
  promotedAt: string;
  deliveryTier: PromotedAlertTier;
}
