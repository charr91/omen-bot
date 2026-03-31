import type { AlertTier } from './signal.js';

export interface WalletProfile {
  address: string;
  ageSeconds: number;
  totalTransactions: number;
  isContract: boolean;
  controllerAddress: string | null;
  firstSeenAt: Date;
  lastActiveAt: Date;
  totalMarkets: number;
  totalFills: number;
  totalVolumeUsd: string;
  liveSuspicionScore: number;
  liveTier: AlertTier;
  isWhitelisted: boolean;
}

export interface WalletChainProfile {
  ageSeconds: number;
  totalTransactions: number;
  isContract: boolean;
  controllerAddress: string | null;
  firstActivityAt: Date;
}
