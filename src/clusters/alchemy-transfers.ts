import { canonicalizeEvmAddress, canonicalizeOptionalEvmAddress } from '../evm/address.js';
import type { AppConfig } from '../config/schema.js';
import type { NewFundingEdge } from '../persistence/queries/funding-edges.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import {
  alchemyMethodCost,
  DEFAULT_COLD_ALCHEMY_RATE_LIMIT,
  fetchWithRetryOn429,
  TokenBucketRateLimiter,
  type AlchemyRateLimitOptions,
} from '../resilience/rate-limit.js';

interface FundingGraphBuilderOptions {
  fetchImpl?: typeof fetch;
  rateLimit?: Partial<AlchemyRateLimitOptions>;
}

interface RpcResponse<TResult> {
  result?: TResult;
  error?: {
    message: string;
  };
}

interface AssetTransfer {
  blockNum?: string;
  from?: string;
  hash?: string;
  transactionHash?: string;
  asset?: string;
  value?: number | string;
}

interface AssetTransferResult {
  transfers?: AssetTransfer[];
}

interface BlockResult {
  timestamp?: string;
}

export interface FundingGraphBuildResult {
  edges: NewFundingEdge[];
  truncated: boolean;
}

const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export class AlchemyFundingGraphBuilder {
  private readonly fetchImpl: typeof fetch;
  private readonly rpcUrl: string;
  private readonly circuitBreaker = new CircuitBreaker('alchemy funding graph');
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly rateLimit: AlchemyRateLimitOptions;
  private rpcCalls = 0;

  constructor(
    apiKey: string | null,
    options: FundingGraphBuilderOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    // box-dry-run: null key => no-Alchemy mode; rebuild jobs fail fast without network.
    this.rpcUrl = apiKey ? `https://polygon-mainnet.g.alchemy.com/v2/${apiKey}` : '';
    this.rateLimit = { ...DEFAULT_COLD_ALCHEMY_RATE_LIMIT, ...options.rateLimit };
    this.rateLimiter = new TokenBucketRateLimiter({
      ratePerSecond: this.rateLimit.cuPerSecond,
      burst: Math.max(this.rateLimit.cuPerSecond, 150),
      maxWaitMs: this.rateLimit.maxWaitMs,
      maxQueue: this.rateLimit.maxQueue,
      label: 'Alchemy funding-graph',
    });
  }

  async buildGraph(
    walletAddress: string,
    config: Pick<AppConfig, 'detection'>,
  ): Promise<FundingGraphBuildResult> {
    const canonicalRootWallet = canonicalizeEvmAddress(walletAddress);
    const visitedWallets = new Set<string>([canonicalRootWallet]);
    const walletsToVisit = [{ address: canonicalRootWallet, depth: 1 }];
    const edges: NewFundingEdge[] = [];
    const blockTimestampCache = new Map<string, Date>();
    this.rpcCalls = 0;
    let truncated = false;

    while (walletsToVisit.length > 0) {
      const nextWallet = walletsToVisit.shift();
      if (!nextWallet) {
        continue;
      }

      if (nextWallet.depth > config.detection.cluster.fundingMaxDepth) {
        continue;
      }

      const inboundTransfers = await this.listInboundTransfers(
        nextWallet.address,
        config.detection.cluster.fanoutLimit,
        config.detection.cluster.maxRpcCalls,
      );
      if (inboundTransfers.truncated) {
        truncated = true;
      }

      for (const transfer of inboundTransfers.transfers) {
        const fromAddress = canonicalizeOptionalEvmAddress(transfer.from ?? null);
        const blockNum = transfer.blockNum;
        if (!fromAddress || !blockNum) {
          continue;
        }

        const timestamp = await this.getBlockTimestamp(blockNum, config.detection.cluster.maxRpcCalls, blockTimestampCache);
        if (timestamp === null) {
          truncated = true;
          break;
        }

        edges.push({
          fromAddress,
          toAddress: nextWallet.address,
          amountUsd: formatAmountUsd(transfer.value),
          asset: sanitizeAsset(transfer.asset),
          txHash: transfer.transactionHash ?? transfer.hash ?? `${fromAddress}:${nextWallet.address}:${blockNum}`,
          timestamp,
          depth: nextWallet.depth,
        });

        if (
          nextWallet.depth < config.detection.cluster.fundingMaxDepth &&
          !visitedWallets.has(fromAddress)
        ) {
          visitedWallets.add(fromAddress);
          walletsToVisit.push({
            address: fromAddress,
            depth: nextWallet.depth + 1,
          });
        }
      }

      if (truncated) {
        break;
      }
    }

    return {
      edges,
      truncated,
    };
  }

  private async listInboundTransfers(
    walletAddress: string,
    fanoutLimit: number,
    maxRpcCalls: number,
  ): Promise<{
    transfers: AssetTransfer[];
    truncated: boolean;
  }> {
    if (!this.canSpendRpcCall(maxRpcCalls)) {
      return {
        transfers: [],
        truncated: true,
      };
    }

    let result: AssetTransferResult | null;
    try {
      result = await this.rpcRequest<AssetTransferResult>('alchemy_getAssetTransfers', [
        {
          fromBlock: '0x0',
          toBlock: 'latest',
          order: 'desc',
          maxCount: toHexCount(fanoutLimit),
          category: ['external', 'erc20'],
          toAddress: walletAddress,
          excludeZeroValue: true,
        },
      ]);
    } catch (error) {
      if (shouldTruncateBuild(error)) {
        return {
          transfers: [],
          truncated: true,
        };
      }

      throw error;
    }

    return {
      transfers: (result?.transfers ?? []).slice(0, fanoutLimit),
      truncated: false,
    };
  }

  private async getBlockTimestamp(
    blockNum: string,
    maxRpcCalls: number,
    cache: Map<string, Date>,
  ): Promise<Date | null> {
    const cachedTimestamp = cache.get(blockNum);
    if (cachedTimestamp) {
      return cachedTimestamp;
    }

    if (!this.canSpendRpcCall(maxRpcCalls)) {
      return null;
    }

    let block: BlockResult | null;
    try {
      block = await this.rpcRequest<BlockResult>('eth_getBlockByNumber', [blockNum, false]);
    } catch (error) {
      if (shouldTruncateBuild(error)) {
        return null;
      }

      throw error;
    }
    const timestampHex = block?.timestamp;
    if (!timestampHex) {
      return null;
    }

    const timestamp = new Date(Number.parseInt(timestampHex, 16) * 1000);
    cache.set(blockNum, timestamp);
    return timestamp;
  }

  private canSpendRpcCall(maxRpcCalls: number): boolean {
    return this.rpcCalls < maxRpcCalls;
  }

  private async rpcRequest<TResult>(method: string, params: unknown[]): Promise<TResult | null> {
    if (!this.rpcUrl) {
      throw new Error(`ALCHEMY_API_KEY not configured (no-Alchemy mode) for ${method}`);
    }

    if (this.circuitBreaker.isOpen()) {
      throw new Error(`Alchemy funding-graph circuit is open`);
    }

    try {
      await this.rateLimiter.acquire(alchemyMethodCost(method));
    } catch {
      throw new Error(`Alchemy funding-graph rate limit exceeded for ${method} (no capacity within ${this.rateLimit.maxWaitMs}ms)`);
    }

    this.rpcCalls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, DEFAULT_RPC_TIMEOUT_MS);

    try {
      const response = await this.circuitBreaker.execute(async () =>
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
        }), { maxRetries: this.rateLimit.max429Retries, baseDelayMs: this.rateLimit.retryBaseDelayMs }),
      );

      if (!response.ok) {
        throw new Error(`Alchemy funding-graph request failed: ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as RpcResponse<TResult>;
      if (payload.error) {
        throw new Error(`Alchemy funding-graph request failed for ${method}: ${payload.error.message}`);
      }

      return payload.result ?? null;
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Alchemy funding-graph request timed out after ${DEFAULT_RPC_TIMEOUT_MS}ms for ${method}`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sanitizeAsset(asset: string | undefined): string {
  const normalized = asset?.trim();
  return normalized && normalized.length > 0 ? normalized : 'UNKNOWN';
}

function formatAmountUsd(value: number | string | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(6);
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed.toFixed(6);
    }
  }

  return '0.000000';
}

function toHexCount(value: number): string {
  return `0x${Math.max(1, Math.floor(value)).toString(16)}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function shouldTruncateBuild(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes('rate limit exceeded') ||
    error.message.includes('circuit is open') ||
    error.message.includes('timed out')
  );
}
