import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config/schema.js';
import { canonicalizeEvmAddress } from '../evm/address.js';
import { createRedisClient } from '../persistence/redis.js';
import {
  buildFundingGraphRebuildCooldownKey,
  COLD_WORKER_HEARTBEAT_KEY,
  FUNDING_GRAPH_REBUILD_JOB_NAME,
  FUNDING_GRAPH_REBUILD_QUEUE_NAME,
} from './constants.js';

export interface FundingGraphRebuildJobData {
  walletAddress: string;
  requestedAt: string;
}

export interface ColdWorkerHeartbeat {
  at: string | null;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
}

export interface ColdPathRuntimeSnapshot extends ColdWorkerHeartbeat {
  waitingCount: number;
  activeCount: number;
  failedCount: number;
  delayedCount: number;
}

export type FundingGraphRebuildRequestResult = 'queued' | 'duplicate' | 'cooldown' | 'stopped';

interface QueueLike {
  add(
    name: string,
    data: FundingGraphRebuildJobData,
    options: {
      jobId: string;
      removeOnComplete: boolean;
      removeOnFail: boolean;
    },
  ): Promise<unknown>;
  close(): Promise<void>;
  getJob(jobId: string): Promise<{ remove(): Promise<void> } | undefined | null>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getJobState(jobId: string): Promise<string>;
}

interface RedisLike {
  disconnect(reconnect?: boolean): void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<unknown>;
}

export class FundingGraphRebuildJobQueue {
  constructor(
    private readonly queue: QueueLike,
    private readonly redis: RedisLike,
    private readonly enabled: boolean,
  ) {}

  async requestRebuild(walletAddress: string): Promise<FundingGraphRebuildRequestResult> {
    if (!this.enabled) {
      return 'stopped';
    }

    const canonicalWalletAddress = canonicalizeEvmAddress(walletAddress);
    const failedUntilRaw = await this.redis.get(buildFundingGraphRebuildCooldownKey(canonicalWalletAddress));
    if (failedUntilRaw !== null) {
      return 'cooldown';
    }

    const state = await this.queue.getJobState(canonicalWalletAddress);
    if (state === 'failed') {
      // This remove-then-add path is intentionally race-tolerant rather than atomic.
      // Concurrent callers can collide here, and the duplicate add fallback below is
      // the correctness boundary that keeps only one live job per wallet.
      const existingJob = await this.queue.getJob(canonicalWalletAddress);
      await existingJob?.remove();
    } else if (state !== 'unknown') {
      return 'duplicate';
    }

    try {
      await this.queue.add(
        FUNDING_GRAPH_REBUILD_JOB_NAME,
        {
          walletAddress: canonicalWalletAddress,
          requestedAt: new Date().toISOString(),
        },
        {
          jobId: canonicalWalletAddress,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      return 'queued';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/duplicate|already exists|jobid/i.test(message)) {
        return 'duplicate';
      }
      throw error;
    }
  }

  async getRuntimeSnapshot(): Promise<ColdPathRuntimeSnapshot> {
    const [counts, heartbeatRaw] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'failed', 'delayed'),
      this.redis.get(COLD_WORKER_HEARTBEAT_KEY),
    ]);
    const heartbeat = parseColdWorkerHeartbeat(heartbeatRaw);

    return {
      waitingCount: counts.waiting ?? 0,
      activeCount: counts.active ?? 0,
      failedCount: counts.failed ?? 0,
      delayedCount: counts.delayed ?? 0,
      ...heartbeat,
    };
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.redis.disconnect(false);
  }
}

export function createBullmqConnection(config: Pick<AppConfig, 'redisUrl'>): Redis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });
}

export function createFundingGraphRebuildJobQueue(
  config: Pick<AppConfig, 'alchemyApiKey' | 'redisUrl'>,
): FundingGraphRebuildJobQueue {
  return new FundingGraphRebuildJobQueue(
    new Queue(FUNDING_GRAPH_REBUILD_QUEUE_NAME, {
      connection: createBullmqConnection(config),
    }),
    createRedisClient(config),
    config.alchemyApiKey !== null,
  );
}

export async function recordFundingGraphRebuildFailureCooldown(
  redis: Pick<RedisLike, 'set'>,
  walletAddress: string,
  durationMs: number,
): Promise<void> {
  const canonicalWalletAddress = canonicalizeEvmAddress(walletAddress);
  await redis.set(
    buildFundingGraphRebuildCooldownKey(canonicalWalletAddress),
    '1',
    'PX',
    durationMs,
  );
}

export function parseColdWorkerHeartbeat(raw: string | null): ColdWorkerHeartbeat {
  if (!raw) {
    return {
      at: null,
      lastCompletedAt: null,
      lastFailedAt: null,
    };
  }

  const parsed = JSON.parse(raw) as {
    at?: string;
    lastCompletedAt?: string | null;
    lastFailedAt?: string | null;
  };

  return {
    at: parsed.at ?? null,
    lastCompletedAt: parsed.lastCompletedAt ?? null,
    lastFailedAt: parsed.lastFailedAt ?? null,
  };
}
