import type { Redis } from 'ioredis';
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

// Weighted up 2026-10-16 (7d outcomes: SYBIL_CLUSTER +12.7pp vs baseline, n=1187). Shadow (deliver = false) by default
// since 2026-10-19: graded at 20/35, never delivered and never lifts a companion signal's tier.
const SYBIL_CLUSTER_BASE_SCORE = 20;
const SYBIL_CLUSTER_BASE_CONFIDENCE = 0.8;
const SYBIL_CLUSTER_ELEVATED_SCORE = 35;
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

  const sybilConfig = context.config.detection.sybilCluster;
  if (sybilConfig && context.cluster.clusterSize > sybilConfig.maxClusterSize) {
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
    ...(sybilConfig && !sybilConfig.deliver ? { shadow: true } : {}),
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
        threshold: sybilConfig
          ? `${context.config.detection.cluster.minSize}-${sybilConfig.maxClusterSize}`
          : `>= ${context.config.detection.cluster.minSize}`,
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

const SYBIL_CLUSTER_MARKET_TTL_SECONDS = 30 * 86_400;

export function sybilClusterMarketKey(clusterId: string, marketId: string): string {
  return `omen:sybil:cluster-market:${clusterId}:${marketId}`;
}

/**
 * One SYBIL_CLUSTER alert per (cluster, market): the first fill claims the pair; later fills from the same cluster
 * on the same market (either side) drop their SYBIL signal. Re-processing the claiming fill keeps it.
 */
export async function keepFirstSybilPerClusterMarket<T extends Pick<TriggeredSignal, 'signalId'>>(
  signals: T[],
  context: { clusterId: string | null; marketId: string; fillId: string },
  redis: Pick<Redis, 'set' | 'get'>,
): Promise<T[]> {
  if (context.clusterId === null || !signals.some((s) => s.signalId === SignalId.SYBIL_CLUSTER)) {
    return signals;
  }
  const key = sybilClusterMarketKey(context.clusterId, context.marketId);
  const claimed =
    (await redis.set(key, context.fillId, 'EX', SYBIL_CLUSTER_MARKET_TTL_SECONDS, 'NX')) === 'OK' ||
    (await redis.get(key)) === context.fillId;
  return claimed ? signals : signals.filter((s) => s.signalId !== SignalId.SYBIL_CLUSTER);
}
