import type { AppConfig } from '../config/schema.js';
import type { PromotedAlert } from '../types/alert.js';
import { RedisAlertDeduper, buildAlertDedupKey } from './dedup.js';
import { TelegramDispatcher } from './telegram.js';

interface RedisDispatchStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<unknown>;
}

interface AlertDispatcherOptions {
  fetchImpl?: typeof fetch;
}

export type AlertDispatchResult =
  | 'sent'
  | 'suppressed-dry-run'
  | 'suppressed-duplicate'
  | 'disabled';

export class AlertDispatcher {
  private readonly deduper: RedisAlertDeduper;
  private readonly telegram: TelegramDispatcher;
  private readonly inFlightKeys = new Set<string>();
  private dryRun: boolean;

  constructor(
    config: Pick<AppConfig, 'alerts' | 'operational' | 'telegram'>,
    redis: RedisDispatchStore,
    options: AlertDispatcherOptions = {},
  ) {
    this.deduper = new RedisAlertDeduper(redis, config.alerts.dedupCooldownMs);
    this.telegram = new TelegramDispatcher(config, options);
    this.dryRun = config.operational.dryRun;
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun;
  }

  async dispatch(alert: PromotedAlert): Promise<AlertDispatchResult> {
    if (this.dryRun) {
      return 'suppressed-dry-run';
    }

    if (!this.telegram.isEnabledForTier(alert.deliveryTier)) {
      return 'disabled';
    }

    const dedupKey = buildAlertDedupKey(alert);
    if (this.inFlightKeys.has(dedupKey) || (await this.deduper.hasRecentDispatch(alert))) {
      return 'suppressed-duplicate';
    }

    this.inFlightKeys.add(dedupKey);
    try {
      await this.telegram.dispatch(alert);
      await this.deduper.markDispatched(alert);
      return 'sent';
    } finally {
      this.inFlightKeys.delete(dedupKey);
    }
  }
}
