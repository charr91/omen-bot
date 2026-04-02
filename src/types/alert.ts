import type { FillOutcome, FillSide } from './fill.js';
import type { AlertTier, TriggeredSignal } from './signal.js';

export type PromotedAlertTier = Exclude<AlertTier, 'CLEAN'>;

export interface AlertLinkedTradeSummary {
  fillId: string;
  fillSide: FillSide;
  fillOutcome: FillOutcome;
  fillPrice?: string | null;
  fillSizeUsd: string;
  fillTimestamp: string;
}

export interface AlertLinkedTradeContext {
  oppositeSide: FillSide;
  recentCount: number;
  latest: AlertLinkedTradeSummary;
}

export interface SignalPreview {
  fillId: string;
  walletAddress: string;
  marketId: string;
  marketQuestion: string;
  marketUrl?: string | null;
  fillSide: FillSide;
  fillOutcome: FillOutcome;
  fillPrice?: string | null;
  fillSizeUsd?: string | null;
  fillTimestamp?: Date | string | null;
  walletLiveScore: number;
  walletLiveTier: AlertTier;
  signal: TriggeredSignal;
  promotedAlertId: string | null;
  promotedAt: string | null;
  dryRun: boolean;
}

export interface PromotedAlert extends SignalPreview {
  promotedAt: string;
  deliveryTier: PromotedAlertTier;
}

export interface StoredAlert extends PromotedAlert {
  id: string;
  dispatchEligible: boolean;
  createdAt: string;
}

export type PresentableAlert = PromotedAlert & {
  linkedTradeContext?: AlertLinkedTradeContext | null;
};
