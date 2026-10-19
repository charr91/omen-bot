import type { Redis } from 'ioredis';
import type { MarketExclusion } from '../signals/market-exclusion.js';

const RETENTION_SECONDS = 8 * 86_400;

/** Daily (UTC) hash of excluded fills: fields `<category>` and `<category>:<source>`. */
export function marketExclusionStatsKey(now: Date = new Date()): string {
  return `omen:hot:market-excluded:${now.toISOString().slice(0, 10)}`;
}

export async function bumpMarketExclusion(
  redis: Pick<Redis, 'hincrby' | 'expire'>,
  exclusion: MarketExclusion,
  now: Date = new Date(),
): Promise<void> {
  const key = marketExclusionStatsKey(now);
  await redis.hincrby(key, exclusion.category, 1);
  await redis.hincrby(key, `${exclusion.category}:${exclusion.source}`, 1);
  await redis.expire(key, RETENTION_SECONDS);
}

export async function readMarketExclusions(
  redis: Pick<Redis, 'hgetall'>,
  now: Date = new Date(),
): Promise<Record<string, number>> {
  const raw = await redis.hgetall(marketExclusionStatsKey(now));
  return Object.fromEntries(Object.entries(raw).map(([field, value]) => [field, Number(value)]));
}
