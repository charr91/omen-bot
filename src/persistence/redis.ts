import { Redis } from 'ioredis';
import type { AppConfig } from '../config/schema.js';

export function createRedisClient(config: Pick<AppConfig, 'redisUrl'>): Redis {
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}

export async function pingRedis(client: Redis): Promise<void> {
  if (client.status === 'wait') {
    await client.connect();
  }

  await client.ping();
}
