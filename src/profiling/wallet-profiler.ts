import type { WalletChainProfile } from '../types/wallet.js';

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
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export class AlchemyWalletProfiler {
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<WalletChainProfile> }>();

  constructor(apiKey: string, options: WalletProfilerOptions = {}) {
    this.rpcUrl = `https://polygon-mainnet.g.alchemy.com/v2/${apiKey}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async profileWallet(address: string): Promise<WalletChainProfile> {
    const cached = this.cache.get(address);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const value = this.loadWalletProfile(address);
    this.cache.set(address, {
      expiresAt: this.now() + this.cacheTtlMs,
      value,
    });

    try {
      return await value;
    } catch (error) {
      this.cache.delete(address);
      throw error;
    }
  }

  private async loadWalletProfile(address: string): Promise<WalletChainProfile> {
    const [transactionCountHex, code, earliestActivityAt] = await Promise.all([
      this.rpcRequest<string>('eth_getTransactionCount', [address, 'latest']),
      this.rpcRequest<string>('eth_getCode', [address, 'latest']),
      this.findEarliestActivity(address),
    ]);

    const firstActivityAt = earliestActivityAt ?? new Date(this.now());
    return {
      ageSeconds: Math.max(0, Math.floor((this.now() - firstActivityAt.getTime()) / 1000)),
      totalTransactions: parseHexInteger(transactionCountHex ?? '0x0'),
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
    });

    if (!response.ok) {
      throw new Error(`Alchemy RPC request failed: ${response.status} ${response.statusText} for ${method}`);
    }

    const payload = (await response.json()) as RpcResponse<TResult>;
    if (payload.error) {
      throw new Error(`Alchemy RPC request failed for ${method}: ${payload.error.message}`);
    }

    return payload.result ?? null;
  }
}

function parseHexInteger(value: string): number {
  return Number.parseInt(value, 16);
}
