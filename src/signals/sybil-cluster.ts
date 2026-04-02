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

const SYBIL_CLUSTER_BASE_SCORE = 15;
const SYBIL_CLUSTER_BASE_CONFIDENCE = 0.8;
const SYBIL_CLUSTER_ELEVATED_SCORE = 30;
const SYBIL_CLUSTER_ELEVATED_CONFIDENCE = 0.9;

export function evaluateSybilCluster(context: SybilClusterSignalContext): TriggeredSignal | null {
  if (context.cluster === null) {
    return null;
  }

  const fillSizeUsd = Number(context.fill.sizeUsd);
  if (
    !Number.isFinite(fillSizeUsd) ||
    fillSizeUsd < context.config.detection.cluster.minFillUsd
  ) {
    return null;
  }

  if (context.cluster.clusterSize < context.config.detection.cluster.minSize) {
    return null;
  }

  if (context.cluster.sameMarketSameSideEntries < 2) {
    return null;
  }

  const isElevated = fillSizeUsd >= context.config.detection.cluster.elevatedFillUsd;
  const score = isElevated ? SYBIL_CLUSTER_ELEVATED_SCORE : SYBIL_CLUSTER_BASE_SCORE;
  const confidence = isElevated ? SYBIL_CLUSTER_ELEVATED_CONFIDENCE : SYBIL_CLUSTER_BASE_CONFIDENCE;

  return {
    signalId: SignalId.SYBIL_CLUSTER,
    availability: 'LIVE',
    score,
    confidence,
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
        field: 'fill_size_usd',
        value: Number(fillSizeUsd.toFixed(2)),
        threshold: `>= ${context.config.detection.cluster.minFillUsd}`,
        description: 'Tiny dust fills are suppressed even when the cluster pattern exists.',
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
