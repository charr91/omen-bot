import { describe, expect, it, vi } from 'vitest';
import { AlchemyWalletProfiler } from '../../../src/profiling/wallet-profiler.js';

function createSuccessfulFetchImpl() {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as {
      method: string;
    };

    switch (payload.method) {
      case 'eth_getTransactionCount':
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3' }));
      case 'eth_getCode':
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }));
      case 'alchemy_getAssetTransfers':
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              transfers: [{ blockNum: '0x10' }],
            },
          }),
        );
      case 'eth_getBlockByNumber':
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              timestamp: '0x64',
            },
          }),
        );
      default:
        throw new Error(`Unexpected RPC method ${payload.method}`);
    }
  });
}

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

  it('evicts expired cache entries and enforces a bounded cache size', async () => {
    let now = 200_000;
    const fetchImpl = createSuccessfulFetchImpl();
    const profiler = new AlchemyWalletProfiler('alchemy-key', {
      fetchImpl,
      cacheTtlMs: 50,
      maxCacheEntries: 2,
      now: () => now,
      rateLimit: { cuPerSecond: 100_000 },
    });

    await profiler.profileWallet('0xwallet-1');
    now += 25;
    await profiler.profileWallet('0xwallet-2');
    now += 60;
    await profiler.profileWallet('0xwallet-3');
    await profiler.profileWallet('0xwallet-4');

    expect((profiler as { cache: Map<string, unknown> }).cache.size).toBe(2);
    expect((profiler as { cache: Map<string, unknown> }).cache.has('0xwallet-1')).toBe(false);
    expect((profiler as { cache: Map<string, unknown> }).cache.has('0xwallet-2')).toBe(false);
  });

  it('aborts hung RPC requests after the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          }),
      );
      const profiler = new AlchemyWalletProfiler('alchemy-key', {
        fetchImpl,
        rpcTimeoutMs: 25,
      });

      const profilePromise = profiler.profileWallet('0xwallet');
      const assertion = expect(profilePromise).rejects.toThrow('timed out after 25ms');
      await vi.advanceTimersByTimeAsync(25);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a controller address only when a contract has a single plausible inbound sender', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        method: string;
      };

      switch (payload.method) {
        case 'eth_getCode':
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1234' }));
        case 'alchemy_getAssetTransfers':
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                transfers: [{ blockNum: '0x10', from: '0xController' }],
              },
            }),
          );
        default:
          throw new Error(`Unexpected RPC method ${payload.method}`);
      }
    });

    const profiler = new AlchemyWalletProfiler('alchemy-key', {
      fetchImpl,
    });

    await expect(profiler.resolveControllerAddress('0xcontract')).resolves.toBe('0xcontroller');
  });
});
