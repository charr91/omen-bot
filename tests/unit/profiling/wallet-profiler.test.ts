import { describe, expect, it, vi } from 'vitest';
import { AlchemyWalletProfiler } from '../../../src/profiling/wallet-profiler.js';

describe('AlchemyWalletProfiler', () => {
  it('builds a chain profile and caches repeated lookups', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0x3',
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0x',
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              transfers: [{ blockNum: '0x10' }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              transfers: [],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              timestamp: '0x64',
            },
          }),
        ),
      );

    const profiler = new AlchemyWalletProfiler('alchemy-key', {
      fetchImpl,
      cacheTtlMs: 60_000,
      now: () => 200_000,
    });

    const first = await profiler.profileWallet('0xwallet');
    const second = await profiler.profileWallet('0xwallet');

    expect(first.totalTransactions).toBe(3);
    expect(first.activityAgeKnown).toBe(true);
    expect(first.isContract).toBe(false);
    expect(first.firstActivityAt.toISOString()).toBe('1970-01-01T00:01:40.000Z');
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('marks wallet age as unknown when transaction history exists but earliest activity lookup is missing', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0x2',
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0x',
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              transfers: [],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              transfers: [],
            },
          }),
        ),
      );

    const profiler = new AlchemyWalletProfiler('alchemy-key', {
      fetchImpl,
      cacheTtlMs: 60_000,
      now: () => 200_000,
    });

    const profile = await profiler.profileWallet('0xwallet');

    expect(profile.totalTransactions).toBe(2);
    expect(profile.activityAgeKnown).toBe(false);
    expect(profile.ageSeconds).toBe(0);
    expect(profile.firstActivityAt).toBeNull();
  });
});
