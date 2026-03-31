import { loadAppConfig } from '../config/index.js';
import { RuntimeStatsCollector } from './runtime-stats.js';
import { HotWorkerClient } from '../hot-worker/client.js';
import { createPolymarketFillSource, type FillSource } from '../ingestion/polymarket-client.js';
import { sleep } from '../phase0/io.js';
import { createDbPool } from '../persistence/db.js';
import { createFillStore, type FillStore } from '../persistence/queries/fills.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { collectHealthReport } from '../resilience/health.js';
import type { FillRecord } from '../types/fill.js';
import type { EnqueueFillResult } from '../types/thread-messages.js';

export interface FillAnalysisQueue {
  enqueue(fill: FillRecord): Promise<EnqueueFillResult>;
}

export interface IngestionCycleResult {
  checkpoint: string | null;
  fetched: number;
  inserted: number;
  replayed: number;
}

interface IngestionCycleOptions {
  fillSource: FillSource;
  fillStore: FillStore;
  analysisQueue: FillAnalysisQueue;
  replayLimit?: number;
}

const DEFAULT_REPLAY_LIMIT = 1_000;
const RUNTIME_STATS_INTERVAL_MS = 60_000;

export async function runIngestionCycle(options: IngestionCycleOptions): Promise<IngestionCycleResult> {
  const latestCursor = await options.fillStore.getLatestFillCursor();
  const recentFills = await options.fillSource.listRecentFills(latestCursor);

  let inserted = 0;
  for (const fill of recentFills) {
    if (await options.fillStore.insertFill(fill)) {
      inserted += 1;
    }
  }

  const replayed = await schedulePendingFills(
    options.fillStore,
    options.analysisQueue,
    options.replayLimit ?? DEFAULT_REPLAY_LIMIT,
  );

  const latestFetchedTimestamp = recentFills.length > 0 ? recentFills[recentFills.length - 1]?.timestamp ?? null : null;
  const checkpoint = latestFetchedTimestamp ?? latestCursor?.timestamp ?? null;

  return {
    checkpoint: checkpoint?.toISOString() ?? null,
    fetched: recentFills.length,
    inserted,
    replayed,
  };
}

export async function runStartCommand(): Promise<void> {
  const config = await loadAppConfig();
  const pool = createDbPool(config);
  const redis = createRedisClient(config);
  const fillStore = createFillStore(pool);
  const fillSource = createPolymarketFillSource(config.ingestion.maxPagesPerPoll);
  const runtimeStatsCollector = new RuntimeStatsCollector();
  const hotWorker = new HotWorkerClient(config, {
    onAlertPreview: (message) => {
      const { type: _type, ...payload } = message;
      process.stdout.write(`${JSON.stringify({ type: 'alert-preview', ...payload })}\n`);
    },
    onWorkerError: (message) => {
      process.stderr.write(`[hot-worker] ${message}\n`);
    },
  });
  let stopping = false;

  const stop = (): void => {
    stopping = true;
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await pingRedis(redis);
    await ensurePersistenceSchema(pool);
    const runtimeStatsTimer = setInterval(() => {
      if (stopping) {
        return;
      }

      const runtimeStats = runtimeStatsCollector.buildLog(
        hotWorker.getRuntimeSnapshot(),
        hotWorker.drainMetrics(),
      );
      process.stdout.write(`${JSON.stringify(runtimeStats)}\n`);
    }, RUNTIME_STATS_INTERVAL_MS);

    if (typeof runtimeStatsTimer.unref === 'function') {
      runtimeStatsTimer.unref();
    }

    try {
      while (!stopping) {
        const result = await runIngestionCycle({
          fillSource,
          fillStore,
          analysisQueue: hotWorker,
        });
        runtimeStatsCollector.recordIngestionCycle(result);
        process.stdout.write(`${JSON.stringify({ type: 'ingest-cycle', ...result })}\n`);

        if (stopping) {
          break;
        }

        await sleep(config.ingestion.pollIntervalMs);
      }
    } finally {
      clearInterval(runtimeStatsTimer);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await hotWorker.waitForIdle(30_000).catch(() => undefined);
    await hotWorker.stop();
    redis.disconnect(false);
    await pool.end();
  }
}

export async function runReplayCommand(): Promise<number> {
  const config = await loadAppConfig();
  const pool = createDbPool(config);
  const redis = createRedisClient(config);
  const fillStore = createFillStore(pool);
  const hotWorker = new HotWorkerClient(config, {
    onAlertPreview: (message) => {
      const { type: _type, ...payload } = message;
      process.stdout.write(`${JSON.stringify({ type: 'alert-preview', ...payload })}\n`);
    },
    onWorkerError: (message) => {
      process.stderr.write(`[hot-worker] ${message}\n`);
    },
  });
  let replayed = 0;

  try {
    await pingRedis(redis);
    await ensurePersistenceSchema(pool);

    while (true) {
      const queued = await schedulePendingFills(fillStore, hotWorker, DEFAULT_REPLAY_LIMIT);
      replayed += queued;
      await hotWorker.waitForIdle(30_000);

      const remaining = await fillStore.listUnanalyzedFills(1);
      if (remaining.length === 0) {
        break;
      }

      if (queued === 0) {
        throw new Error('Replay stalled with unanalyzed fills still remaining');
      }
    }

    process.stdout.write(`${JSON.stringify({ type: 'replay', replayed })}\n`);
    return replayed;
  } finally {
    await hotWorker.stop();
    redis.disconnect(false);
    await pool.end();
  }
}

export async function runHealthCommand(): Promise<void> {
  const config = await loadAppConfig();
  const report = await collectHealthReport(config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'ok') {
    process.exitCode = 1;
  }
}

async function schedulePendingFills(
  fillStore: FillStore,
  analysisQueue: FillAnalysisQueue,
  limit: number,
): Promise<number> {
  const pendingFills = await fillStore.listUnanalyzedFills(limit);
  let queued = 0;

  for (const fill of pendingFills) {
    const result = await analysisQueue.enqueue(fill);
    if (result === 'accepted') {
      queued += 1;
      continue;
    }

    if (result === 'full') {
      break;
    }
  }

  return queued;
}
