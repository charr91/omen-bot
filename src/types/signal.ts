export type SignalAvailability = 'LIVE' | 'POST_RESOLUTION';
export type AlertTier = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAN';

export enum SignalId {
  FRESH_WALLET_LARGE_POSITION = 'FRESH_WALLET_LARGE_POSITION',
  OUTSIZED_POSITION = 'OUTSIZED_POSITION',
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
}
