import type { AppConfig } from '../config/schema.js';
import { HOT_WORKER_HEARTBEAT_KEY, HOT_WORKER_HEARTBEAT_TTL_MS } from '../hot-worker/constants.js';
import { fetchPublicTrades } from '../phase0/public-api.js';
import { createDbPool, pingDatabase } from '../persistence/db.js';
import { createFillStore } from '../persistence/queries/fills.js';
import { createSignalEventStore } from '../persistence/queries/signal-events.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';

const RECENT_SIGNAL_EVENTS_WINDOW_MINUTES = 60;

export interface HealthCheckResult {
  status: 'ok' | 'error';
  latencyMs: number;
  error: string | null;
}

export interface RuntimeHealthSummary {
  queueDepth: number | null;
  processing: boolean | null;
  lastHeartbeatAt: string | null;
  lastProcessedAt: string | null;
  lastProcessedAgeMs: number | null;
  unanalyzedFillCount: number | null;
  newestFillTimestamp: string | null;
  recentSignalEventCount: number | null;
  recentSignalEventsWindowMinutes: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checkedAt: string;
  services: {
    postgres: HealthCheckResult;
    redis: HealthCheckResult;
    polymarketRest: HealthCheckResult;
    hotWorker: HealthCheckResult;
  };
  runtime: RuntimeHealthSummary;
}

export async function collectHealthReport(config: AppConfig): Promise<HealthReport> {
  const postgres = await measureHealth(async () => {
    const pool = createDbPool(config);
    try {
      await pingDatabase(pool);
    } finally {
      await pool.end();
    }
  });

  const redis = await measureHealth(async () => {
    const client = createRedisClient(config);
    try {
      await pingRedis(client);
    } finally {
      client.disconnect(false);
    }
  });

  const polymarketRest = await measureHealth(async () => {
    await fetchPublicTrades(0);
  });

  const hotWorker = await measureHealth(async () => {
    const client = createRedisClient(config);
    try {
      await pingRedis(client);
      const raw = await client.get(HOT_WORKER_HEARTBEAT_KEY);
      if (!raw) {
        throw new Error('No recent hot-worker heartbeat found');
      }

      const parsed = JSON.parse(raw) as {
        at?: string;
      };
      const heartbeatAt = parsed.at ? Date.parse(parsed.at) : Number.NaN;
      if (!Number.isFinite(heartbeatAt)) {
        throw new Error('Hot-worker heartbeat payload is invalid');
      }

      if (Date.now() - heartbeatAt > HOT_WORKER_HEARTBEAT_TTL_MS) {
        throw new Error('Hot-worker heartbeat is stale');
      }
    } finally {
      client.disconnect(false);
    }
  });

  const status = [postgres, redis, polymarketRest, hotWorker].every((service) => service.status === 'ok')
    ? 'ok'
    : 'degraded';
  const runtime = await collectRuntimeSummary(config);

  return {
    status,
    checkedAt: new Date().toISOString(),
    services: {
      postgres,
      redis,
      polymarketRest,
      hotWorker,
    },
    runtime,
  };
}

async function collectRuntimeSummary(config: AppConfig): Promise<RuntimeHealthSummary> {
  const pool = createDbPool(config);
  const fillStore = createFillStore(pool);
  const signalEventStore = createSignalEventStore(pool);
  const redis = createRedisClient(config);

  try {
    const [fillSummary, recentSignalEventCount, heartbeatRaw] = await Promise.all([
      fillStore.getRuntimeSummary(),
      signalEventStore.countRecentLiveSignalEvents(
        new Date(Date.now() - RECENT_SIGNAL_EVENTS_WINDOW_MINUTES * 60_000),
      ),
      redis.get(HOT_WORKER_HEARTBEAT_KEY),
    ]);

    const heartbeat = parseHeartbeatPayload(heartbeatRaw);
    const lastProcessedAtMs = heartbeat.lastProcessedAt ? Date.parse(heartbeat.lastProcessedAt) : Number.NaN;

    return {
      queueDepth: heartbeat.queueDepth,
      processing: heartbeat.processing,
      lastHeartbeatAt: heartbeat.at,
      lastProcessedAt: heartbeat.lastProcessedAt,
      lastProcessedAgeMs: Number.isFinite(lastProcessedAtMs) ? Date.now() - lastProcessedAtMs : null,
      unanalyzedFillCount: fillSummary.unanalyzedFillCount,
      newestFillTimestamp: fillSummary.newestFillTimestamp?.toISOString() ?? null,
      recentSignalEventCount,
      recentSignalEventsWindowMinutes: RECENT_SIGNAL_EVENTS_WINDOW_MINUTES,
    };
  } catch {
    return {
      queueDepth: null,
      processing: null,
      lastHeartbeatAt: null,
      lastProcessedAt: null,
      lastProcessedAgeMs: null,
      unanalyzedFillCount: null,
      newestFillTimestamp: null,
      recentSignalEventCount: null,
      recentSignalEventsWindowMinutes: RECENT_SIGNAL_EVENTS_WINDOW_MINUTES,
    };
  } finally {
    redis.disconnect(false);
    await pool.end();
  }
}

async function measureHealth(operation: () => Promise<void>): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  try {
    await operation();
    return {
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseHeartbeatPayload(raw: string | null): {
  at: string | null;
  queueDepth: number | null;
  processing: boolean | null;
  lastProcessedAt: string | null;
} {
  if (!raw) {
    return {
      at: null,
      queueDepth: null,
      processing: null,
      lastProcessedAt: null,
    };
  }

  const parsed = JSON.parse(raw) as {
    at?: string;
    queueDepth?: number;
    processing?: boolean;
    lastProcessedAt?: string | null;
  };

  return {
    at: parsed.at ?? null,
    queueDepth: typeof parsed.queueDepth === 'number' ? parsed.queueDepth : null,
    processing: typeof parsed.processing === 'boolean' ? parsed.processing : null,
    lastProcessedAt: parsed.lastProcessedAt ?? null,
  };
}
