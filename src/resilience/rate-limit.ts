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
