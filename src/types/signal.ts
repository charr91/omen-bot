export type SignalAvailability = 'LIVE' | 'POST_RESOLUTION';
export type AlertTier = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAN';

export enum SignalId {
  FRESH_WALLET_LARGE_POSITION = 'FRESH_WALLET_LARGE_POSITION',
  OUTSIZED_POSITION = 'OUTSIZED_POSITION',
  NICHE_MARKET_ENTRY = 'NICHE_MARKET_ENTRY',
  CONVICTION_SIZE_MISMATCH = 'CONVICTION_SIZE_MISMATCH',
  LUMP_ENTRY = 'LUMP_ENTRY',
  SYBIL_CLUSTER = 'SYBIL_CLUSTER',
  FRESH_WALLET_LONGSHOT = 'FRESH_WALLET_LONGSHOT',
}

export interface SignalEvidence {
  field: string;
  value: string | number;
  threshold: string | number;
  description: string;
}

export interface TriggeredSignal {
  signalId: SignalId;
  availability: SignalAvailability;
  score: number;
  confidence: number;
  evidence: SignalEvidence[];
  triggeredAt: Date;
  /** Shadow mode: recorded + outcome-graded but never delivered (Telegram/Discord/feed). */
  shadow?: boolean;
}
