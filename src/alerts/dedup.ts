import type { AlertDeliveryChannelName } from './channel.js';
import type { PromotedAlert } from '../types/alert.js';

interface RedisDedupStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<unknown>;
}

const ALERT_DEDUP_PREFIX = 'omen:dedup';

export function buildAlertDedupKey(
  channel: AlertDeliveryChannelName,
  alert: Pick<PromotedAlert, 'marketId' | 'walletAddress' | 'signal'>,
): string {
  return `${ALERT_DEDUP_PREFIX}:${channel}:${alert.marketId}:${alert.walletAddress}:${alert.signal.signalId}`;
}

export class RedisAlertDeduper {
  constructor(
    private readonly store: RedisDedupStore,
    private readonly cooldownMs: number,
  ) {}

  async hasRecentDispatch(
    channel: AlertDeliveryChannelName,
    alert: Pick<PromotedAlert, 'marketId' | 'walletAddress' | 'signal'>,
  ): Promise<boolean> {
    return (await this.store.get(buildAlertDedupKey(channel, alert))) !== null;
  }

  async markDispatched(
    channel: AlertDeliveryChannelName,
    alert: Pick<PromotedAlert, 'marketId' | 'walletAddress' | 'signal'>,
    dispatchedAt = new Date(),
  ): Promise<void> {
    await this.store.set(
      buildAlertDedupKey(channel, alert),
      dispatchedAt.toISOString(),
      'PX',
      this.cooldownMs,
    );
  }
}
