import { loadAppConfig } from '../config/index.js';
import { createPolymarketFillSource, type FillSource } from '../ingestion/polymarket-client.js';
import { sleep } from '../phase0/io.js';
import { createDbPool } from '../persistence/db.js';
import { createFillStore, type FillStore } from '../persistence/queries/fills.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { collectHealthReport } from '../resilience/health.js';
import type { FillRecord } from '../types/fill.js';

export interface FillAnalyzer {
  analyze(fill: FillRecord): Promise<void>;
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
  analyzer: FillAnalyzer;
  replayLimit?: number;
}

const DEFAULT_REPLAY_LIMIT = 1_000;

export async function runIngestionCycle(options: IngestionCycleOptions): Promise<IngestionCycleResult> {
  const latestTimestamp = await options.fillStore.getLatestFillTimestamp();
  const recentFills = await options.fillSource.listRecentFills(latestTimestamp?.getTime() ?? null);

  let inserted = 0;
  for (const fill of recentFills) {
    if (await options.fillStore.insertFill(fill)) {
      inserted += 1;
    }
  }

  const pendingFills = await options.fillStore.listUnanalyzedFills(options.replayLimit ?? DEFAULT_REPLAY_LIMIT);
  for (const fill of pendingFills) {
    await options.analyzer.analyze(fill);
    await options.fillStore.markFillAnalyzed(fill.id);
  }

  return {
    checkpoint: latestTimestamp?.toISOString() ?? null,
    fetched: recentFills.length,
    inserted,
    replayed: pendingFills.length,
  };
}

export async function runStartCommand(): Promise<void> {
  const config = await loadAppConfig();
  const pool = createDbPool(config);
  const redis = createRedisClient(config);
  const fillStore = createFillStore(pool);
  const fillSource = createPolymarketFillSource(config.ingestion.maxPagesPerPoll);
  const analyzer = createNoopAnalyzer();
  let stopping = false;

  const stop = (): void => {
    stopping = true;
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await pingRedis(redis);
    await ensurePersistenceSchema(pool);

    while (!stopping) {
      const result = await runIngestionCycle({
        fillSource,
        fillStore,
        analyzer,
      });
      process.stdout.write(`${JSON.stringify({ type: 'ingest-cycle', ...result })}\n`);

      if (stopping) {
        break;
      }

      await sleep(config.ingestion.pollIntervalMs);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    redis.disconnect(false);
    await pool.end();
  }
}

export async function runReplayCommand(): Promise<number> {
  const config = await loadAppConfig();
  const pool = createDbPool(config);
  const redis = createRedisClient(config);
  const fillStore = createFillStore(pool);
  const analyzer = createNoopAnalyzer();

  try {
    await pingRedis(redis);
    await ensurePersistenceSchema(pool);

    const pendingFills = await fillStore.listUnanalyzedFills(DEFAULT_REPLAY_LIMIT);
    for (const fill of pendingFills) {
      await analyzer.analyze(fill);
      await fillStore.markFillAnalyzed(fill.id);
    }

    process.stdout.write(`${JSON.stringify({ type: 'replay', replayed: pendingFills.length })}\n`);
    return pendingFills.length;
  } finally {
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

function createNoopAnalyzer(): FillAnalyzer {
  return {
    async analyze(): Promise<void> {
      return undefined;
    },
  };
}
