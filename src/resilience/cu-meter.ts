import { alchemyMethodCost } from './rate-limit.js';

/**
 * Process-local Alchemy compute-unit counter, flushed to Redis so the hot worker (thread) and cold worker
 * (child process) add up into one daily total: hash `omen:alchemy:cu:<YYYY-MM-DD UTC>` with one field per component.
 */
export const ALCHEMY_CU_KEY_PREFIX = 'omen:alchemy:cu:';
const KEY_TTL_SECONDS = 40 * 24 * 60 * 60;

export interface CuRedisLike {
  hincrby(key: string, field: string, increment: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export function alchemyCuKey(date: Date): string {
  return `${ALCHEMY_CU_KEY_PREFIX}${date.toISOString().slice(0, 10)}`;
}

export class AlchemyCuMeter {
  private pending = new Map<string, number>();

  record(method: string, cu = alchemyMethodCost(method)): void {
    const day = alchemyCuKey(new Date());
    this.pending.set(day, (this.pending.get(day) ?? 0) + cu);
  }

  pendingTotal(): number {
    let total = 0;
    for (const value of this.pending.values()) total += value;
    return total;
  }

  async flush(redis: CuRedisLike, component: string): Promise<void> {
    const batch = this.pending;
    this.pending = new Map();
    for (const [key, cu] of batch) {
      try {
        await redis.hincrby(key, component, cu);
        await redis.expire(key, KEY_TTL_SECONDS);
      } catch (error) {
        this.pending.set(key, (this.pending.get(key) ?? 0) + cu);
        throw error;
      }
    }
  }
}

/** One meter per process (each worker thread / child process gets its own module instance). */
export const alchemyCuMeter = new AlchemyCuMeter();

export function startCuMeterFlush(redis: CuRedisLike, component: string, intervalMs = 15_000): () => Promise<void> {
  const timer = setInterval(() => {
    void alchemyCuMeter.flush(redis, component).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await alchemyCuMeter.flush(redis, component).catch(() => undefined);
  };
}

export interface AlchemyCuUsage {
  day: string;
  totalCu: number;
  byComponent: Record<string, number>;
  /** Today's rate extrapolated to a 30-day month. */
  projectedMonthlyCu: number;
}

export async function readAlchemyCuUsage(redis: CuRedisLike, now = new Date()): Promise<AlchemyCuUsage> {
  const key = alchemyCuKey(now);
  const raw = await redis.hgetall(key);
  const byComponent = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
  const totalCu = Object.values(byComponent).reduce((sum, value) => sum + value, 0);
  const startOfDay = Date.parse(`${key.slice(ALCHEMY_CU_KEY_PREFIX.length)}T00:00:00Z`);
  const elapsedDays = Math.max((now.getTime() - startOfDay) / 86_400_000, 1 / 24);
  return {
    day: key.slice(ALCHEMY_CU_KEY_PREFIX.length),
    totalCu,
    byComponent,
    projectedMonthlyCu: Math.round((totalCu / elapsedDays) * 30),
  };
}
