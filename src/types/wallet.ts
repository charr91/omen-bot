import type { AlertTier } from './signal.js';

export interface WalletProfile {
  address: string;
  ageSeconds: number;
  activityAgeKnown: boolean;
  totalTransactions: number;
  isContract: boolean;
  controllerAddress: string | null;
  freshnessAgeSeconds: number;
  freshnessActivityAgeKnown: boolean;
  freshnessTotalTransactions: number;
  firstSeenAt: Date;
  lastActiveAt: Date;
  totalMarkets: number;
  totalFills: number;
  totalVolumeUsd: string;
  fundingClusterId: string | null;
  liveSuspicionScore: number;
  liveTier: AlertTier;
  isWhitelisted: boolean;
}

export interface WalletChainProfile {
  ageSeconds: number;
  activityAgeKnown: boolean;
  totalTransactions: number;
  isContract: boolean;
  controllerAddress: string | null;
  freshnessAgeSeconds: number;
  freshnessActivityAgeKnown: boolean;
  freshnessTotalTransactions: number;
  firstActivityAt: Date | null;
}
