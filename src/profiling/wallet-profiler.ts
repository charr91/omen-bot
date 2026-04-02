import type { WalletChainProfile } from '../types/wallet.js';
import { canonicalizeEvmAddress } from '../evm/address.js';

interface RpcResponse<TResult> {
  result?: TResult;
  error?: {
    code: number;
    message: string;
  };
}

interface AssetTransfer {
  blockNum: string;
}

interface AssetTransferResult {
  transfers?: AssetTransfer[];
}

interface BlockResult {
  timestamp?: string;
}

interface WalletProfilerOptions {
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  rpcTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 2_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

interface CachedWalletProfile {
  expiresAt: number;
  value: Promise<WalletChainProfile>;
}

export class AlchemyWalletProfiler {
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly rpcTimeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedWalletProfile>();

  constructor(apiKey: string, options: WalletProfilerOptions = {}) {
    this.rpcUrl = `https://polygon-mainnet.g.alchemy.com/v2/${apiKey}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async profileWallet(address: string): Promise<WalletChainProfile> {
    const canonicalAddress = canonicalizeEvmAddress(address);
    const now = this.now();
    this.pruneCache(now);

    const cached = this.cache.get(canonicalAddress);
    if (cached && cached.expiresAt > now) {
      this.touchCacheEntry(canonicalAddress, cached);
      return cached.value;
    }

    if (cached) {
      this.cache.delete(canonicalAddress);
    }

    const value = this.loadWalletProfile(canonicalAddress);
    this.cache.set(canonicalAddress, {
      expiresAt: now + this.cacheTtlMs,
      value,
    });
    this.enforceCacheLimit();

    try {
      return await value;
    } catch (error) {
      this.cache.delete(canonicalAddress);
      throw error;
    }
  }

  private async loadWalletProfile(address: string): Promise<WalletChainProfile> {
    const [transactionCountHex, code, earliestActivityAt] = await Promise.all([
      this.rpcRequest<string>('eth_getTransactionCount', [address, 'latest']),
      this.rpcRequest<string>('eth_getCode', [address, 'latest']),
      this.findEarliestActivity(address),
    ]);
    const totalTransactions = parseHexInteger(transactionCountHex ?? '0x0');

    if (earliestActivityAt === null && totalTransactions > 0) {
      return {
        ageSeconds: 0,
        activityAgeKnown: false,
        totalTransactions,
        isContract: (code ?? '0x') !== '0x',
        controllerAddress: null,
        firstActivityAt: null,
      };
    }

    const firstActivityAt = earliestActivityAt ?? new Date(this.now());
    return {
      ageSeconds: Math.max(0, Math.floor((this.now() - firstActivityAt.getTime()) / 1000)),
      activityAgeKnown: true,
      totalTransactions,
      isContract: (code ?? '0x') !== '0x',
      controllerAddress: null,
      firstActivityAt,
    };
  }

  private async findEarliestActivity(address: string): Promise<Date | null> {
    const [inbound, outbound] = await Promise.all([
      this.rpcRequest<AssetTransferResult>('alchemy_getAssetTransfers', [
        {
          fromBlock: '0x0',
          toBlock: 'latest',
          order: 'asc',
          maxCount: '0x1',
          category: ['external', 'erc20'],
          toAddress: address,
        },
      ]),
      this.rpcRequest<AssetTransferResult>('alchemy_getAssetTransfers', [
        {
          fromBlock: '0x0',
          toBlock: 'latest',
          order: 'asc',
          maxCount: '0x1',
          category: ['external', 'erc20'],
          fromAddress: address,
        },
      ]),
    ]);

    const candidateBlockNumbers = [inbound?.transfers?.[0]?.blockNum, outbound?.transfers?.[0]?.blockNum]
      .filter((value): value is string => typeof value === 'string');

    if (candidateBlockNumbers.length === 0) {
      return null;
    }

    const earliestBlock = candidateBlockNumbers.reduce((left, right) =>
      parseHexInteger(left) <= parseHexInteger(right) ? left : right,
    );

    const block = await this.rpcRequest<BlockResult>('eth_getBlockByNumber', [earliestBlock, false]);
    const timestampHex = block?.timestamp;

    if (!timestampHex) {
      return null;
    }

    return new Date(parseHexInteger(timestampHex) * 1000);
  }

  private async rpcRequest<TResult>(method: string, params: unknown[]): Promise<TResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.rpcTimeoutMs);

    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Alchemy RPC request failed: ${response.status} ${response.statusText} for ${method}`);
      }

      const payload = (await response.json()) as RpcResponse<TResult>;
      if (payload.error) {
        throw new Error(`Alchemy RPC request failed for ${method}: ${payload.error.message}`);
      }

      return payload.result ?? null;
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Alchemy RPC request timed out after ${this.rpcTimeoutMs}ms for ${method}`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private pruneCache(now: number): void {
    for (const [address, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(address);
      }
    }
  }

  private enforceCacheLimit(): void {
    while (this.cache.size > this.maxCacheEntries) {
      const oldestAddress = this.cache.keys().next().value;
      if (typeof oldestAddress !== 'string') {
        break;
      }

      this.cache.delete(oldestAddress);
    }
  }

  private touchCacheEntry(address: string, entry: CachedWalletProfile): void {
    this.cache.delete(address);
    this.cache.set(address, entry);
  }
}

export async function pingAlchemyRpc(
  apiKey: string,
  options: Pick<WalletProfilerOptions, 'fetchImpl' | 'rpcTimeoutMs'> = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, rpcTimeoutMs);

  try {
    const response = await fetchImpl(`https://polygon-mainnet.g.alchemy.com/v2/${apiKey}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: [],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Alchemy RPC request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as RpcResponse<string>;
    if (payload.error) {
      throw new Error(`Alchemy RPC request failed: ${payload.error.message}`);
    }

    if (typeof payload.result !== 'string' || !payload.result.startsWith('0x')) {
      throw new Error('Alchemy RPC request returned an invalid block number');
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Alchemy RPC request timed out after ${rpcTimeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function parseHexInteger(value: string): number {
  return Number.parseInt(value, 16);
}
