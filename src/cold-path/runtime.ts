import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { AlchemyFundingGraphBuilder } from '../clusters/alchemy-transfers.js';
import { loadAppConfig } from '../config/index.js';
import { createDbPool } from '../persistence/db.js';
import { createFundingEdgeStore } from '../persistence/queries/funding-edges.js';
import { createWalletStore } from '../persistence/queries/wallets.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { createAppLogger, emitStructuredLog } from '../logging/logger.js';
import {
  COLD_WORKER_HEARTBEAT_INTERVAL_MS,
  COLD_WORKER_HEARTBEAT_KEY,
  COLD_WORKER_HEARTBEAT_TTL_MS,
  FUNDING_GRAPH_REBUILD_JOB_NAME,
  FUNDING_GRAPH_REBUILD_QUEUE_NAME,
} from './constants.js';
import {
  createBullmqConnection,
  recordFundingGraphRebuildFailureCooldown,
  type FundingGraphRebuildJobData,
} from './queue.js';
import { AlchemyDailyBudget, startCuMeterFlush } from '../resilience/cu-meter.js';
import { createColdJobRelevanceStore } from './relevance.js';
import { executeFundingGraphRebuild, type FundingGraphRebuildResult } from './rebuild.js';

interface ColdWorkerRuntimeState {
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
}

export async function runColdWorkerCommand(): Promise<void> {
  const config = await loadAppConfig();
  if (!config.alchemyApiKey && !(process.env.OMEN_ALLOW_MISSING_ALCHEMY === 'true')) {
    throw new Error('ALCHEMY_API_KEY is required to start the cold worker');
  }
  const alchemyApiKey = config.alchemyApiKey;

  const logger = createAppLogger(config, {
    component: 'cold-worker',
  });
  const pool = createDbPool(config);
  const heartbeatRedis = createRedisClient(config);
  const fundingEdgeStore = createFundingEdgeStore(pool);
  const walletStore = createWalletStore(pool);
  const relevanceStore = createColdJobRelevanceStore(pool);
  const stopCuMeter = startCuMeterFlush(heartbeatRedis, 'cold');
  const coldBudget = new AlchemyDailyBudget(heartbeatRedis, {
    dailyCu: config.alchemy.dailyCuBudget,
    share: 1 - config.alchemy.hotBudgetShare,
    component: 'cold',
  });
  const builder = new AlchemyFundingGraphBuilder(alchemyApiKey, {
    rateLimit: {
      cuPerSecond: config.alchemy.coldCuPerSecond,
      maxWaitMs: config.alchemy.maxWaitMs,
      maxQueue: config.alchemy.maxQueue,
      max429Retries: config.alchemy.max429Retries,
    },
  });
  const runtimeState: ColdWorkerRuntimeState = {
    lastCompletedAt: null,
    lastFailedAt: null,
  };
  const worker = new Worker<FundingGraphRebuildJobData, FundingGraphRebuildResult, typeof FUNDING_GRAPH_REBUILD_JOB_NAME>(
    FUNDING_GRAPH_REBUILD_QUEUE_NAME,
    async (job) =>
      executeFundingGraphRebuild({
        walletAddress: job.data.walletAddress,
        builder,
        fundingEdgeStore,
        walletStore,
        config,
        relevance: {
          store: relevanceStore,
          minFillUsd: config.coldPath.rebuildMinFillUsd,
          rebuildIfSignaled: config.coldPath.rebuildIfSignaled,
          budgetExhausted: () => coldBudget.isExhausted(),
        },
      }),
    {
      connection: createBullmqConnection(config),
      concurrency: config.coldPath.concurrency,
      removeOnComplete: {
        count: 0,
      },
      removeOnFail: {
        count: 100,
      },
    },
  );
  const stopController = new AbortController();
  const stop = (): void => {
    if (stopController.signal.aborted) {
      return;
    }

    stopController.abort();
  };

  worker.on('active', (job) => {
    emitStructuredLog(logger, {
      type: 'cold-path-job',
      status: 'active',
      walletAddress: job.data.walletAddress,
    });
  });
  worker.on('completed', (job, result) => {
    runtimeState.lastCompletedAt = new Date().toISOString();
    emitStructuredLog(logger, {
      type: 'cold-path-job',
      status: result.skipped ? 'skipped' : 'completed',
      ...(result.skipped ? { reason: result.skipped } : {}),
      walletAddress: job.data.walletAddress,
      edgeCount: result.edgeCount,
      truncated: result.truncated,
      fundingClusterId: result.fundingClusterId,
    });
  });
  worker.on('failed', (job, error) => {
    runtimeState.lastFailedAt = new Date().toISOString();
    if (job) {
      void recordFundingGraphRebuildFailureCooldown(
        heartbeatRedis,
        job.data.walletAddress,
        config.coldPath.rebuildFailureCooldownMs,
      ).catch((cooldownError) => {
        logger.error({
          type: 'cold-path-job',
          status: 'cooldown-write-failed',
          walletAddress: job.data.walletAddress,
          error: formatError(cooldownError),
        });
      });
    }

    logger.error({
      type: 'cold-path-job',
      status: 'failed',
      walletAddress: job?.data.walletAddress ?? null,
      error: formatError(error),
    });
  });

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const heartbeatTimer = setInterval(() => {
    void emitHeartbeat(heartbeatRedis, runtimeState).catch((error) => {
      logger.error({
        type: 'cold-worker',
        status: 'heartbeat-failed',
        error: formatError(error),
      });
    });
  }, COLD_WORKER_HEARTBEAT_INTERVAL_MS);

  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  try {
    await pingRedis(heartbeatRedis);
    await ensurePersistenceSchema(pool);
    await worker.waitUntilReady();
    await emitHeartbeat(heartbeatRedis, runtimeState);
    emitStructuredLog(logger, {
      type: 'cold-worker',
      status: 'ready',
      concurrency: config.coldPath.concurrency,
    });

    await waitForStop(stopController.signal);

    emitStructuredLog(logger, {
      type: 'cold-worker',
      status: 'stopping',
    });
  } finally {
    clearInterval(heartbeatTimer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await worker.close();
    await stopCuMeter();
    heartbeatRedis.disconnect(false);
    await pool.end();
  }
}

async function emitHeartbeat(
  redis: Pick<ReturnType<typeof createRedisClient>, 'set'>,
  runtimeState: ColdWorkerRuntimeState,
): Promise<void> {
  await redis.set(
    COLD_WORKER_HEARTBEAT_KEY,
    JSON.stringify({
      at: new Date().toISOString(),
      lastCompletedAt: runtimeState.lastCompletedAt,
      lastFailedAt: runtimeState.lastFailedAt,
    }),
    'PX',
    COLD_WORKER_HEARTBEAT_TTL_MS,
  );
}

async function waitForStop(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
