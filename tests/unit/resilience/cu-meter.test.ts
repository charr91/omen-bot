import { describe, expect, it, vi } from 'vitest';
import { AlchemyCuMeter, alchemyCuKey, readAlchemyCuUsage } from '../../../src/resilience/cu-meter.js';

function fakeRedis() {
  const store = new Map<string, Record<string, string>>();
  return {
    store,
    hincrby: vi.fn(async (key: string, field: string, inc: number) => {
      const hash = store.get(key) ?? {};
      hash[field] = String(Number(hash[field] ?? 0) + inc);
      store.set(key, hash);
    }),
    expire: vi.fn(async () => 1),
    hsetnx: vi.fn(async (key: string, field: string, value: string) => {
      const hash = store.get(key) ?? {};
      if (hash[field] === undefined) hash[field] = value;
      store.set(key, hash);
    }),
    hgetall: vi.fn(async (key: string) => store.get(key) ?? {}),
  };
}

describe('AlchemyCuMeter', () => {
  it('weights calls by method CU and flushes per component into a daily hash', async () => {
    const meter = new AlchemyCuMeter();
    meter.record('alchemy_getAssetTransfers');
    meter.record('eth_getCode');
    meter.record('eth_call');
    expect(meter.pendingTotal()).toBe(150 + 20 + 26);

    const redis = fakeRedis();
    await meter.flush(redis, 'hot');
    expect(meter.pendingTotal()).toBe(0);
    expect(redis.store.get(alchemyCuKey(new Date()))).toMatchObject({ hot: '196' });
  });

  it('keeps unflushed CU when Redis fails', async () => {
    const meter = new AlchemyCuMeter();
    meter.record('eth_getCode');
    const redis = { ...fakeRedis(), hincrby: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(meter.flush(redis, 'cold')).rejects.toThrow('down');
    expect(meter.pendingTotal()).toBe(20);
  });

  it('sums components and projects a 30-day month from the elapsed part of the UTC day', async () => {
    const redis = fakeRedis();
    const now = new Date('2026-10-12T12:00:00Z');
    redis.store.set(alchemyCuKey(now), { hot: '100000', cold: '400000' });
    const usage = await readAlchemyCuUsage(redis, now);
    expect(usage).toEqual({
      day: '2026-10-12',
      totalCu: 500_000,
      byComponent: { hot: 100_000, cold: 400_000 },
      projectedMonthlyCu: 30_000_000,
    });
  });

  it('projects from the first metered call when metering started mid-day', async () => {
    const redis = fakeRedis();
    const now = new Date('2026-10-12T12:00:00Z');
    redis.store.set(alchemyCuKey(now), {
      _firstAt: String(Date.parse('2026-10-12T11:00:00Z')),
      cold: '10000',
    });
    const usage = await readAlchemyCuUsage(redis, now);
    expect(usage.byComponent).toEqual({ cold: 10_000 });
    expect(usage.projectedMonthlyCu).toBe(10_000 * 24 * 30);
  });
});
