import { describe, expect, it } from 'vitest';
import {
  alchemyMethodCost,
  fetchWithRetryOn429,
  RateLimitWaitTimeoutError,
  TokenBucketRateLimiter,
} from '../../../src/resilience/rate-limit.js';

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

describe('TokenBucketRateLimiter', () => {
  it('admits a burst up to capacity without waiting', async () => {
    const c = fakeClock();
    const l = new TokenBucketRateLimiter({ ratePerSecond: 280, maxWaitMs: 20_000, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 14; i += 1) await l.acquire(20);
    expect(c.sleeps).toEqual([]);
  });

  it('waits for capacity instead of throwing, weighted by CU', async () => {
    const c = fakeClock();
    const l = new TokenBucketRateLimiter({ ratePerSecond: 100, burst: 150, maxWaitMs: 20_000, now: c.now, sleep: c.sleep });
    await l.acquire(150);
    await l.acquire(150);
    expect(c.sleeps).toEqual([1500]);
  });

  it('queues concurrent callers FIFO with cumulative waits', async () => {
    const c = fakeClock();
    const waits: number[] = [];
    const l = new TokenBucketRateLimiter({
      ratePerSecond: 100,
      maxWaitMs: 20_000,
      now: c.now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await Promise.all([l.acquire(100), l.acquire(100), l.acquire(100)]);
    expect(waits).toEqual([1000, 2000]);
  });

  it('keeps sustained throughput at the configured rate', async () => {
    const c = fakeClock();
    const l = new TokenBucketRateLimiter({ ratePerSecond: 280, maxWaitMs: 60_000, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 100; i += 1) await l.acquire(alchemyMethodCost('alchemy_getAssetTransfers'));
    // 100 * 150 CU = 15000 CU; minus 280 initial burst => ~52.6s
    expect(c.now()).toBeGreaterThanOrEqual(((15_000 - 280) / 280) * 1000 - 1);
  });

  it('throws a rate-limit error once the wait would exceed maxWaitMs, without consuming tokens', async () => {
    const c = fakeClock();
    const l = new TokenBucketRateLimiter({ ratePerSecond: 10, burst: 20, maxWaitMs: 1_000, now: c.now, sleep: async () => {} });
    await l.acquire(20);
    await expect(l.acquire(20)).rejects.toBeInstanceOf(RateLimitWaitTimeoutError);
    await expect(l.acquire(20)).rejects.toThrow(/rate limit exceeded/);
    c.advance(1_000);
    await expect(l.acquire(10)).resolves.toBeUndefined();
  });

  it('rejects when the wait queue is full', async () => {
    const c = fakeClock();
    const l = new TokenBucketRateLimiter({
      ratePerSecond: 10, maxWaitMs: 100_000, maxQueue: 1, now: c.now, sleep: () => new Promise(() => {}),
    });
    await l.acquire(10);
    void l.acquire(10);
    await expect(l.acquire(10)).rejects.toBeInstanceOf(RateLimitWaitTimeoutError);
  });
});

describe('fetchWithRetryOn429', () => {
  const res = (status: number, headers: Record<string, string> = {}) =>
    new Response('{}', { status, headers });

  it('retries 429 with backoff then succeeds', async () => {
    const statuses = [429, 429, 200];
    const sleeps: number[] = [];
    const r = await fetchWithRetryOn429(async () => res(statuses.shift()!), {
      maxRetries: 3, baseDelayMs: 100, sleep: async (ms) => { sleeps.push(ms); }, random: () => 1,
    });
    expect(r.status).toBe(200);
    expect(sleeps).toEqual([100, 200]);
  });

  it('honours Retry-After and gives up after maxRetries', async () => {
    const sleeps: number[] = [];
    const r = await fetchWithRetryOn429(async () => res(429, { 'retry-after': '2' }), {
      maxRetries: 2, baseDelayMs: 100, sleep: async (ms) => { sleeps.push(ms); }, random: () => 1,
    });
    expect(r.status).toBe(429);
    expect(sleeps).toEqual([2000, 2000]);
  });
});

describe('alchemyMethodCost', () => {
  it('uses the CU table with a conservative default', () => {
    expect(alchemyMethodCost('alchemy_getAssetTransfers')).toBe(150);
    expect(alchemyMethodCost('eth_getTransactionCount')).toBe(20);
    expect(alchemyMethodCost('unknown_method')).toBe(26);
  });
});
