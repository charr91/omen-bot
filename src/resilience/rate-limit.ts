interface SlidingWindowRateLimiterOptions {
  now?: () => number;
}

export class SlidingWindowRateLimiter {
  private readonly now: () => number;
  private readonly timestamps: number[] = [];

  constructor(
    private readonly maxOperations: number,
    private readonly windowMs: number,
    options: SlidingWindowRateLimiterOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  tryAcquire(): boolean {
    const currentTime = this.now();
    while (this.timestamps.length > 0) {
      const oldestTimestamp = this.timestamps[0];
      if (oldestTimestamp === undefined || currentTime - oldestTimestamp < this.windowMs) {
        break;
      }
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxOperations) {
      return false;
    }

    this.timestamps.push(currentTime);
    return true;
  }
}

/**
 * Alchemy compute-unit cost per JSON-RPC method (conservative, per Alchemy CU pricing docs;
 * note specs/OMEN-SPEC-v2.0.md quotes ~10 CU for getAssetTransfers, which understates current pricing).
 */
export const ALCHEMY_METHOD_CU: Readonly<Record<string, number>> = {
  alchemy_getAssetTransfers: 150,
  eth_getTransactionCount: 20,
  eth_getBlockByNumber: 20,
  eth_getCode: 20,
  eth_getBalance: 20,
  eth_call: 26,
};
export const DEFAULT_ALCHEMY_METHOD_CU = 26;

export function alchemyMethodCost(method: string): number {
  return ALCHEMY_METHOD_CU[method] ?? DEFAULT_ALCHEMY_METHOD_CU;
}

export class RateLimitWaitTimeoutError extends Error {
  constructor(label: string, maxWaitMs: number) {
    // keep the historical 'rate limit exceeded' phrase so existing fallback matching still applies
    super(`${label} rate limit exceeded (waited > ${maxWaitMs}ms for capacity)`);
    this.name = 'RateLimitWaitTimeoutError';
  }
}

export interface TokenBucketOptions {
  /** Sustained refill rate in cost units (CU) per second. */
  ratePerSecond: number;
  /** Bucket capacity (max burst). Defaults to ratePerSecond (1s of budget). */
  burst?: number;
  /** Max time a caller waits for capacity before acquire() rejects. */
  maxWaitMs: number;
  /** Max queued waiters; beyond this acquire() rejects immediately. */
  maxQueue?: number;
  label?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Cost-weighted token bucket that waits (FIFO) for capacity instead of failing fast.
 * Rejects only when a request would wait longer than maxWaitMs or the queue is full,
 * so callers can keep their existing fallback path.
 */
export class TokenBucketRateLimiter {
  private readonly rate: number;
  private readonly capacity: number;
  private readonly maxWaitMs: number;
  private readonly maxQueue: number;
  private readonly label: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefill: number;
  /** Tokens already promised to queued waiters (FIFO reservation). */
  private reservedUntil = 0;
  private waiters = 0;

  constructor(options: TokenBucketOptions) {
    if (!(options.ratePerSecond > 0)) throw new Error('ratePerSecond must be > 0');
    this.rate = options.ratePerSecond;
    this.capacity = options.burst ?? options.ratePerSecond;
    this.maxWaitMs = options.maxWaitMs;
    this.maxQueue = options.maxQueue ?? 1_000;
    this.label = options.label ?? 'rate limiter';
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  get queued(): number {
    return this.waiters;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.rate) / 1000);
    this.lastRefill = t;
  }

  /** Waits until `cost` units are available. Throws RateLimitWaitTimeoutError if that would exceed maxWaitMs. */
  async acquire(cost = 1): Promise<void> {
    const effectiveCost = Math.min(cost, this.capacity);
    this.refill();
    // Reserve tokens immediately (may go negative); negative balance = debt queued callers pay off in order.
    const deficit = effectiveCost - this.tokens;
    const waitMs = deficit <= 0 ? 0 : Math.ceil((deficit * 1000) / this.rate);
    if (waitMs > this.maxWaitMs || (waitMs > 0 && this.waiters >= this.maxQueue)) {
      throw new RateLimitWaitTimeoutError(this.label, this.maxWaitMs);
    }
    this.tokens -= effectiveCost;
    if (waitMs === 0) return;
    this.waiters += 1;
    try {
      await this.sleep(waitMs);
    } finally {
      this.waiters -= 1;
    }
  }
}

export interface RetryOn429Options {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Retries a fetch-like call on HTTP 429 with exponential backoff + jitter, honouring Retry-After. */
export async function fetchWithRetryOn429(
  doFetch: () => Promise<Response>,
  options: RetryOn429Options,
): Promise<Response> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const maxDelay = options.maxDelayMs ?? 10_000;
  for (let attempt = 0; ; attempt += 1) {
    const response = await doFetch();
    if (response.status !== 429 || attempt >= options.maxRetries) return response;
    const retryAfter = Number(response.headers?.get?.('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : options.baseDelayMs * 2 ** attempt;
    await sleep(Math.min(maxDelay, backoff) * (0.5 + random() * 0.5));
  }
}

export interface AlchemyRateLimitOptions {
  cuPerSecond: number;
  maxWaitMs: number;
  maxQueue: number;
  max429Retries: number;
  retryBaseDelayMs: number;
}

/** Hot worker + cold worker are separate processes sharing one key: 200 + 80 = 280 CU/s (< 330 free tier). */
export const DEFAULT_HOT_ALCHEMY_RATE_LIMIT: AlchemyRateLimitOptions = {
  cuPerSecond: 200,
  maxWaitMs: 20_000,
  maxQueue: 500,
  max429Retries: 3,
  retryBaseDelayMs: 500,
};
export const DEFAULT_COLD_ALCHEMY_RATE_LIMIT: AlchemyRateLimitOptions = {
  ...DEFAULT_HOT_ALCHEMY_RATE_LIMIT,
  cuPerSecond: 80,
  maxWaitMs: 30_000,
};
