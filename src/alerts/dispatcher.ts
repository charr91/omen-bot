import type { AppConfig } from '../config/schema.js';
import type { PromotedAlert } from '../types/alert.js';
import type { AlertDeliveryChannel, AlertDeliveryChannelName, AlertDispatchResult } from './channel.js';
import { RedisAlertDeduper, buildAlertDedupKey } from './dedup.js';
import { DiscordDispatcher } from './discord.js';
import { TelegramDispatcher } from './telegram.js';

interface RedisDispatchStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<unknown>;
}

interface AlertDispatcherOptions {
  fetchImpl?: typeof fetch;
}

export class AlertDispatcher {
  private readonly deduper: RedisAlertDeduper;
  private readonly channels: AlertDeliveryChannel[];
  private readonly inFlightKeys = new Set<string>();
  private dryRun: boolean;

  constructor(
    config: Pick<AppConfig, 'alerts' | 'operational' | 'telegram' | 'discord'>,
    redis: RedisDispatchStore,
    options: AlertDispatcherOptions = {},
  ) {
    this.deduper = new RedisAlertDeduper(redis, config.alerts.dedupCooldownMs);
    this.channels = [new TelegramDispatcher(config, options), new DiscordDispatcher(config, options)];
    this.dryRun = config.operational.dryRun;
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun;
  }

  async dispatch(alert: PromotedAlert): Promise<AlertDispatchResult> {
    const enabledChannels = this.channels.filter((channel) => channel.isEnabledForTier(alert.deliveryTier));

    if (this.dryRun) {
      return {
        status: 'suppressed-dry-run',
        channels: enabledChannels.map((channel) => channel.name),
        failedChannels: [],
      };
    }

    if (enabledChannels.length === 0) {
      return {
        status: 'disabled',
        channels: [],
        failedChannels: [],
      };
    }

    const sentChannels: AlertDeliveryChannelName[] = [];
    const failedChannels: AlertDeliveryChannelName[] = [];
    let duplicateChannels = 0;

    for (const channel of enabledChannels) {
      const dedupKey = buildAlertDedupKey(channel.name, alert);
      if (this.inFlightKeys.has(dedupKey)) {
        duplicateChannels += 1;
        continue;
      }

      this.inFlightKeys.add(dedupKey);
      try {
        if (await this.deduper.hasRecentDispatch(channel.name, alert)) {
          duplicateChannels += 1;
          continue;
        }

        try {
          await channel.dispatch(alert);
          await this.deduper.markDispatched(channel.name, alert);
          sentChannels.push(channel.name);
        } catch {
          failedChannels.push(channel.name);
        }
      } finally {
        this.inFlightKeys.delete(dedupKey);
      }
    }

    if (sentChannels.length > 0) {
      return {
        status: failedChannels.length > 0 ? 'sent-partial' : 'sent',
        channels: sentChannels,
        failedChannels,
      };
    }

    if (duplicateChannels === enabledChannels.length) {
      return {
        status: 'suppressed-duplicate',
        channels: enabledChannels.map((channel) => channel.name),
        failedChannels: [],
      };
    }

    return {
      status: failedChannels.length > 0 ? 'failed' : 'disabled',
      channels: [],
      failedChannels,
    };
  }
}
