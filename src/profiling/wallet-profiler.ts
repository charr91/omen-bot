import type { WalletChainProfile } from '../types/wallet.js';
import { canonicalizeEvmAddress, canonicalizeOptionalEvmAddress } from '../evm/address.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import {
  alchemyMethodCost,
  fetchWithRetryOn429,
  TokenBucketRateLimiter,
  type AlchemyRateLimitOptions,
  DEFAULT_HOT_ALCHEMY_RATE_LIMIT,
} from '../resilience/rate-limit.js';

interface RpcResponse<TResult> {
  result?: TResult;
  error?: {
    code: number;
    message: string;
  };
}

interface AssetTransfer {
  blockNum: string;
  from?: string;
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
  controllerCacheTtlMs?: number;
  controllerLookupFanout?: number;
  rpcTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  rateLimit?: Partial<AlchemyRateLimitOptions>;
}

const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 2_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_CONTROLLER_CACHE_TTL_MS = 15 * 60_000;
const DEFAULT_CONTROLLER_LOOKUP_FANOUT = 5;
const OWNER_SELECTOR = '0x8da5cb5b'; // owner()
// Gnosis Safe storage: slot 2 = mapping owners (linked list from SENTINEL 0x1), slot 3 = ownerCount.
const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001';
const SAFE_OWNER_COUNT_SLOT = '0x3';
// keccak256(abi.encode(address(0x1), uint256(2))) = storage key of owners[SENTINEL] (the first owner).
const SAFE_FIRST_OWNER_SLOT = '0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0';
const IS_OWNER_SELECTOR = '0x2f54bf6e'; // isOwner(address)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface CachedWalletProfile {
  expiresAt: number;
  value: Promise<WalletChainProfile>;
}

interface CachedControllerAddress {
  expiresAt: number;
  value: Promise<string | null>;
}

export class AlchemyWalletProfiler {
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly controllerCacheTtlMs: number;
  private readonly controllerLookupFanout: number;
  private readonly rpcTimeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedWalletProfile>();
  private readonly controllerCache = new Map<string, CachedControllerAddress>();
  private readonly rpcCircuitBreaker = new CircuitBreaker('alchemy rpc');
  private readonly rpcRateLimiter: TokenBucketRateLimiter;
  private readonly retry429: AlchemyRateLimitOptions;

  constructor(apiKey: string | null, options: WalletProfilerOptions = {}) {
    // box-dry-run: null key => no-Alchemy mode; every RPC fails fast (conservative fallback), no network.
    this.rpcUrl = apiKey ? `https://polygon-mainnet.g.alchemy.com/v2/${apiKey}` : '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.controllerCacheTtlMs = options.controllerCacheTtlMs ?? DEFAULT_CONTROLLER_CACHE_TTL_MS;
    this.controllerLookupFanout = options.controllerLookupFanout ?? DEFAULT_CONTROLLER_LOOKUP_FANOUT;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.retry429 = { ...DEFAULT_HOT_ALCHEMY_RATE_LIMIT, ...options.rateLimit };
    this.rpcRateLimiter = new TokenBucketRateLimiter({
      ratePerSecond: this.retry429.cuPerSecond,
      burst: Math.max(this.retry429.cuPerSecond, 150),
      maxWaitMs: this.retry429.maxWaitMs,
      maxQueue: this.retry429.maxQueue,
      label: 'Alchemy RPC',
    });
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

  async resolveControllerAddress(address: string): Promise<string | null> {
    const canonicalAddress = canonicalizeEvmAddress(address);
    const now = this.now();
    this.pruneControllerCache(now);

    const cached = this.controllerCache.get(canonicalAddress);
    if (cached && cached.expiresAt > now) {
      this.touchControllerCacheEntry(canonicalAddress, cached);
      return cached.value;
    }

    if (cached) {
      this.controllerCache.delete(canonicalAddress);
    }

    const value = this.loadControllerAddress(canonicalAddress);
    this.controllerCache.set(canonicalAddress, {
      expiresAt: now + this.controllerCacheTtlMs,
      value,
    });
    this.enforceControllerCacheLimit();

    try {
      return await value;
    } catch (error) {
      this.controllerCache.delete(canonicalAddress);
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
        freshnessAgeSeconds: 0,
        freshnessActivityAgeKnown: false,
        freshnessTotalTransactions: totalTransactions,
        firstActivityAt: null,
      };
    }

    const firstActivityAt = earliestActivityAt ?? new Date(this.now());
    const ageSeconds = Math.max(0, Math.floor((this.now() - firstActivityAt.getTime()) / 1000));
    return {
      ageSeconds,
      activityAgeKnown: true,
      totalTransactions,
      isContract: (code ?? '0x') !== '0x',
      controllerAddress: null,
      freshnessAgeSeconds: ageSeconds,
      freshnessActivityAgeKnown: true,
      freshnessTotalTransactions: totalTransactions,
      firstActivityAt,
    };
  }

  /**
   * Resolve the EOA that controls a Polymarket proxy wallet.
   *
   * Polymarket proxies are funded with USDC/USDC.e/pUSD (not native POL), so inbound native transfers rarely
   * identify the owner. Ownership is read on-chain instead, in order of reliability:
   *   1. `owner()`        – Polymarket beacon-proxy deposit wallets.
   *   2. Gnosis Safe storage – Polymarket browser-wallet Safes (their singleton has no `getOwners()`):
   *                         ownerCount (slot 3) must be 1, then owners[SENTINEL] (mapping at slot 2) is the owner.
   *   3. `isOwner(addr)`  – other owner-checking proxies: verify the first inbound external/erc20 senders.
   *   4. Fallback: a single unique inbound sender (external + erc20), for proxies with no owner view
   *      (e.g. Polymarket's EIP-1167 ProxyWallet clones, whose owner is only implied by the CREATE2 salt).
   */
  private async loadControllerAddress(address: string): Promise<string | null> {
    const code = await this.rpcRequest<string>('eth_getCode', [address, 'latest']);
    if ((code ?? '0x') === '0x') {
      return null;
    }

    const ownerWord = await this.tryEthCall(address, OWNER_SELECTOR);
    const owner = decodeAddressWord(ownerWord);
    if (owner !== null) {
      return owner;
    }

    const safeOwner = await this.readSafeSingleOwner(address);
    if (safeOwner !== undefined) {
      return safeOwner;
    }

    const inbound = await this.rpcRequest<AssetTransferResult>('alchemy_getAssetTransfers', [
      {
        fromBlock: '0x0',
        toBlock: 'latest',
        order: 'asc',
        maxCount: toHexCount(this.controllerLookupFanout),
        category: ['external', 'erc20'],
        toAddress: address,
        excludeZeroValue: true,
      },
    ]);

    const senders = [
      ...new Set(
        (inbound?.transfers ?? [])
          .map((transfer) => canonicalizeOptionalEvmAddress(transfer.from ?? null))
          .filter((value): value is string => value !== null && value !== ZERO_ADDRESS),
      ),
    ];

    let isOwnerSupported = false;
    for (const sender of senders) {
      const result = await this.tryEthCall(address, `${IS_OWNER_SELECTOR}${sender.slice(2).padStart(64, '0')}`);
      if (result === null) {
        break;
      }

      isOwnerSupported = true;
      if (decodeBoolWord(result)) {
        return sender;
      }
    }

    if (isOwnerSupported) {
      return null;
    }

    return senders.length === 1 ? (senders[0] ?? null) : null;
  }

  /**
   * Returns the owner of a single-owner Safe, null for a multi-owner Safe, undefined if the storage layout
   * does not look like a Safe.
   */
  private async readSafeSingleOwner(address: string): Promise<string | null | undefined> {
    const [countWord, firstOwnerWord] = await Promise.all([
      this.rpcRequest<string>('eth_getStorageAt', [address, SAFE_OWNER_COUNT_SLOT, 'latest']),
      this.rpcRequest<string>('eth_getStorageAt', [address, SAFE_FIRST_OWNER_SLOT, 'latest']),
    ]);
    const firstOwner = decodeAddressWord(firstOwnerWord);
    const ownerCount = countWord ? Number.parseInt(countWord, 16) : 0;
    if (firstOwner === null || firstOwner === SAFE_SENTINEL || !Number.isSafeInteger(ownerCount) || ownerCount < 1) {
      return undefined;
    }

    return ownerCount === 1 ? firstOwner : null;
  }

  /** eth_call that returns null when the call reverts (e.g. the selector is not implemented). */
  private async tryEthCall(to: string, data: string): Promise<string | null> {
    try {
      const result = await this.rpcRequest<string>('eth_call', [{ to, data }, 'latest']);
      return typeof result === 'string' && result !== '0x' ? result : null;
    } catch (error) {
      if (error instanceof Error && /execution reverted|revert/i.test(error.message)) {
        return null;
      }

      throw error;
    }
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
    if (!this.rpcUrl) {
      throw new Error(`ALCHEMY_API_KEY not configured (no-Alchemy mode) for ${method}`);
    }

    if (this.rpcCircuitBreaker.isOpen()) {
      throw new Error(`Alchemy RPC circuit is open`);
    }

    try {
      await this.rpcRateLimiter.acquire(alchemyMethodCost(method));
    } catch {
      throw new Error(`Alchemy RPC rate limit exceeded for ${method} (no capacity within ${this.retry429.maxWaitMs}ms)`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.rpcTimeoutMs);

    try {
      const response = await this.rpcCircuitBreaker.execute(async () =>
        fetchWithRetryOn429(() => this.fetchImpl(this.rpcUrl, {
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
        }), { maxRetries: this.retry429.max429Retries, baseDelayMs: this.retry429.retryBaseDelayMs }),
      );

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

  private pruneControllerCache(now: number): void {
    for (const [address, entry] of this.controllerCache.entries()) {
      if (entry.expiresAt <= now) {
        this.controllerCache.delete(address);
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

  private enforceControllerCacheLimit(): void {
    while (this.controllerCache.size > this.maxCacheEntries) {
      const oldestAddress = this.controllerCache.keys().next().value;
      if (typeof oldestAddress !== 'string') {
        break;
      }

      this.controllerCache.delete(oldestAddress);
    }
  }

  private touchControllerCacheEntry(address: string, entry: CachedControllerAddress): void {
    this.controllerCache.delete(address);
    this.controllerCache.set(address, entry);
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

function toHexCount(value: number): string {
  return `0x${Math.max(1, Math.floor(value)).toString(16)}`;
}

function decodeAddressWord(word: string | null): string | null {
  if (word === null || !/^0x[0-9a-fA-F]{64}$/.test(word)) {
    return null;
  }

  if (!/^0x0{24}/.test(word)) {
    return null;
  }

  const address = `0x${word.slice(-40).toLowerCase()}`;
  return address === ZERO_ADDRESS ? null : address;
}

function decodeBoolWord(word: string): boolean {
  return /^0x0*1$/.test(word);
}
