import type { AppConfig } from '../config/schema.js';
import { fetchPublicTrades } from '../phase0/public-api.js';
import { createDbPool, pingDatabase } from '../persistence/db.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';

export interface HealthCheckResult {
  status: 'ok' | 'error';
  latencyMs: number;
  error: string | null;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checkedAt: string;
  services: {
    postgres: HealthCheckResult;
    redis: HealthCheckResult;
    polymarketRest: HealthCheckResult;
  };
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

  const status = [postgres, redis, polymarketRest].every((service) => service.status === 'ok')
    ? 'ok'
    : 'degraded';

  return {
    status,
    checkedAt: new Date().toISOString(),
    services: {
      postgres,
      redis,
      polymarketRest,
    },
  };
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
