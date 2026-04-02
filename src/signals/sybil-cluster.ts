import type { AppConfig } from '../config/schema.js';
import type { FillRecord } from '../types/fill.js';
import { SignalId, type TriggeredSignal } from '../types/signal.js';

export interface LiveClusterSignalContext {
  fundingClusterId: string;
  clusterSize: number;
  sameMarketSameSideEntries: number;
}

interface SybilClusterSignalContext {
  fill: FillRecord;
  cluster: LiveClusterSignalContext | null;
  config: Pick<AppConfig, 'detection'>;
}

const SYBIL_CLUSTER_SCORE = 25;
const SYBIL_CLUSTER_CONFIDENCE = 0.85;

export function evaluateSybilCluster(context: SybilClusterSignalContext): TriggeredSignal | null {
  if (context.cluster === null) {
    return null;
  }

  if (context.cluster.clusterSize < context.config.detection.cluster.minSize) {
    return null;
  }

  if (context.cluster.sameMarketSameSideEntries < 2) {
    return null;
  }

  return {
    signalId: SignalId.SYBIL_CLUSTER,
    availability: 'LIVE',
    score: SYBIL_CLUSTER_SCORE,
    confidence: SYBIL_CLUSTER_CONFIDENCE,
    evidence: [
      {
        field: 'funding_cluster_id',
        value: context.cluster.fundingClusterId,
        threshold: `>= ${context.config.detection.cluster.minSize} wallets`,
        description: 'The wallet belongs to a shared-funder cluster large enough to matter.',
      },
      {
        field: 'cluster_size',
        value: context.cluster.clusterSize,
        threshold: `>= ${context.config.detection.cluster.minSize}`,
        description: 'Cluster membership meets the minimum size threshold.',
      },
      {
        field: 'same_market_same_side_entries',
        value: context.cluster.sameMarketSameSideEntries,
        threshold: '>= 2',
        description: 'Multiple cluster members entered the same side of this market within the lookback window.',
      },
    ],
    triggeredAt: new Date(),
  };
}
