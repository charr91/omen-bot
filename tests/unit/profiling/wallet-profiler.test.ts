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
        case 'eth_call':
          return revertResponse();
        case 'eth_getStorageAt':
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: word('0') }));
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

  it('reads the owner of a Polymarket beacon-proxy deposit wallet via owner()', async () => {
    const calls: string[] = [];
    const fetchImpl = proxyFetch(calls, {
      '0x8da5cb5b': word('4528f342ae92a2360f99cf913cfc6511a448459f'),
    });
    const profiler = new AlchemyWalletProfiler('alchemy-key', { fetchImpl });

    await expect(profiler.resolveControllerAddress('0xproxy')).resolves.toBe(
      '0x4528f342ae92a2360f99cf913cfc6511a448459f',
    );
    expect(calls).not.toContain('alchemy_getAssetTransfers');
  });

  it('reads the owner of a single-owner Gnosis Safe from storage and rejects multi-owner safes', async () => {
    const firstOwnerSlot = '0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0';
    const single = proxyFetch([], {}, [], {
      '0x3': word('1'),
      [firstOwnerSlot]: word('aa'.repeat(20)),
    });
    await expect(
      new AlchemyWalletProfiler('k', { fetchImpl: single }).resolveControllerAddress('0xsafe'),
    ).resolves.toBe(`0x${'aa'.repeat(20)}`);

    const multi = proxyFetch([], {}, [], {
      '0x3': word('2'),
      [firstOwnerSlot]: word('bb'.repeat(20)),
    });
    await expect(
      new AlchemyWalletProfiler('k', { fetchImpl: multi }).resolveControllerAddress('0xsafe'),
    ).resolves.toBeNull();
  });

  it('verifies USDC-funding senders with isOwner() when the proxy has no owner getters', async () => {
    const owner = 'cf8acb7e2bd62cd84974c647666f0263f265409c';
    const fetchImpl = proxyFetch(
      [],
      { [`0x2f54bf6e${pad(owner)}`]: word('1'), '0x2f54bf6e': word('0') },
      [
        { blockNum: '0x1', from: '0x3a3bd7bb9528e159577f7c2e685cc81a765002e2' },
        { blockNum: '0x2', from: `0x${owner}` },
        { blockNum: '0x3', from: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045' },
      ],
    );
    const profiler = new AlchemyWalletProfiler('k', { fetchImpl });

    await expect(profiler.resolveControllerAddress('0xproxy')).resolves.toBe(`0x${owner}`);
    const transferRequest = fetchImpl.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)) as { method: string; params: [{ category: string[] }] })
      .find((body) => body.method === 'alchemy_getAssetTransfers');
    expect(transferRequest?.params[0].category).toEqual(['external', 'erc20']);
  });

  it('falls back to a single unique erc20 sender (ignoring mints) when no owner view exists', async () => {
    const fetchImpl = proxyFetch([], {}, [
      { blockNum: '0x1', from: '0x0000000000000000000000000000000000000000' },
      { blockNum: '0x2', from: '0xFunder' },
      { blockNum: '0x3', from: '0xfunder' },
    ]);
    await expect(
      new AlchemyWalletProfiler('k', { fetchImpl }).resolveControllerAddress('0xproxy'),
    ).resolves.toBe('0xfunder');
  });

  it('uses a 12h default profile cache TTL', async () => {
    let now = 0;
    const fetchImpl = createSuccessfulFetchImpl();
    const profiler = new AlchemyWalletProfiler('k', { fetchImpl, now: () => now });
    await profiler.profileWallet('0xwallet');
    const callsAfterFirst = fetchImpl.mock.calls.length;
    now = 11 * 60 * 60_000;
    await profiler.profileWallet('0xwallet');
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
    now = 12 * 60 * 60_000 + 1;
    await profiler.profileWallet('0xwallet');
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

function pad(hex: string): string {
  return hex.padStart(64, '0');
}

function word(hex: string): string {
  return `0x${pad(hex)}`;
}

function revertResponse(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
  );
}

function proxyFetch(
  methods: string[],
  callResults: Record<string, string>,
  transfers: Array<{ blockNum: string; from: string }> = [],
  storage: Record<string, string> = {},
) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    methods.push(payload.method);
    switch (payload.method) {
      case 'eth_getCode':
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1234' }));
      case 'eth_call': {
        const data = (payload.params[0] as { data: string }).data;
        const result = callResults[data] ?? callResults[data.slice(0, 10)];
        return result === undefined
          ? revertResponse()
          : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      }
      case 'eth_getStorageAt': {
        const slot = payload.params[1] as string;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: storage[slot] ?? word('0') }));
      }
      case 'alchemy_getAssetTransfers':
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { transfers } }));
      default:
        throw new Error(`Unexpected RPC method ${payload.method}`);
    }
  });
}
