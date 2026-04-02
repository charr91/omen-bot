interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(
    private readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  async execute<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    if (this.isOpen()) {
      throw new Error(`${this.name} circuit is open`);
    }

    try {
      const result = await operation();
      this.consecutiveFailures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openUntil = this.now() + this.resetTimeoutMs;
      }
      throw error;
    }
  }

  // Best-effort preflight for callers that want to avoid spending a rate-limit token
  // when the breaker is already open. This is not a lock: the authoritative guarded
  // operation must still run through execute(), and this check may reset the breaker
  // once the timeout has elapsed.
  isOpen(): boolean {
    const currentTime = this.now();
    if (this.openUntil === 0) {
      return false;
    }

    if (currentTime >= this.openUntil) {
      this.openUntil = 0;
      this.consecutiveFailures = 0;
      return false;
    }

    return true;
  }
}
