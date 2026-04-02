export const FUNDING_GRAPH_REBUILD_QUEUE_NAME = 'omen:funding-graph-rebuild';
export const FUNDING_GRAPH_REBUILD_JOB_NAME = 'funding-graph-rebuild';
export const COLD_WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const COLD_WORKER_HEARTBEAT_TTL_MS = COLD_WORKER_HEARTBEAT_INTERVAL_MS * 3;
export const COLD_WORKER_HEARTBEAT_KEY = 'omen:health:cold-worker';

export function buildFundingGraphRebuildCooldownKey(walletAddress: string): string {
  return `omen:cold-path:funding-graph-rebuild:cooldown:${walletAddress.toLowerCase()}`;
}
