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
    private readonly minScoreIncrease = 10,
  ) {}

  async hasRecentDispatch(
    channel: AlertDeliveryChannelName,
    alert: Pick<PromotedAlert, 'marketId' | 'walletAddress' | 'signal' | 'walletLiveScore'>,
  ): Promise<boolean> {
    const raw = await this.store.get(buildAlertDedupKey(channel, alert));
    if (raw === null) {
      return false;
    }

    const previousDispatch = parseStoredDispatch(raw);
    const previousScore = previousDispatch.walletLiveScore ?? 0;

    return alert.walletLiveScore - previousScore <= this.minScoreIncrease;
  }

  async markDispatched(
    channel: AlertDeliveryChannelName,
    alert: Pick<PromotedAlert, 'marketId' | 'walletAddress' | 'signal' | 'walletLiveScore'>,
    dispatchedAt = new Date(),
  ): Promise<void> {
    await this.store.set(
      buildAlertDedupKey(channel, alert),
      JSON.stringify({
        dispatchedAt: dispatchedAt.toISOString(),
        walletLiveScore: alert.walletLiveScore,
      }),
      'PX',
      this.cooldownMs,
    );
  }
}

function parseStoredDispatch(raw: string): {
  dispatchedAt: string;
  walletLiveScore: number | null;
} {
  try {
    const parsed = JSON.parse(raw) as {
      dispatchedAt?: string;
      walletLiveScore?: number;
    };
    return {
      dispatchedAt: parsed.dispatchedAt ?? raw,
      walletLiveScore: typeof parsed.walletLiveScore === 'number' ? parsed.walletLiveScore : null,
    };
  } catch {
    return {
      dispatchedAt: raw,
      walletLiveScore: null,
    };
  }
}
