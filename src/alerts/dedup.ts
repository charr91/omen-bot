import type { PromotedAlert } from '../types/alert.js';

interface RedisDedupStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<unknown>;
}

const ALERT_DEDUP_PREFIX = 'omen:dedup';

export function buildAlertDedupKey(
  alert: Pick<PromotedAlert, 'marketId' | 'walletAddress' | 'signal'>,
): string {
  return `${ALERT_DEDUP_PREFIX}:${alert.marketId}:${alert.walletAddress}:${alert.signal.signalId}`;
}

export class RedisAlertDeduper {
  constructor(
    private readonly store: RedisDedupStore,
    private readonly cooldownMs: number,
  ) {}

  async hasRecentDispatch(alert: Pick<PromotedAlert, 'marketId' | 'walletAddress' | 'signal'>): Promise<boolean> {
    return (await this.store.get(buildAlertDedupKey(alert))) !== null;
  }

  async markDispatched(
    alert: Pick<PromotedAlert, 'marketId' | 'walletAddress' | 'signal'>,
    dispatchedAt = new Date(),
  ): Promise<void> {
    await this.store.set(
      buildAlertDedupKey(alert),
      dispatchedAt.toISOString(),
      'PX',
      this.cooldownMs,
    );
  }
}
