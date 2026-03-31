import type { AppConfig } from '../config/schema.js';
import type { PromotedAlert } from '../types/alert.js';
import type {
  AlertChannelDispatchResult,
  AlertDeliveryChannel,
  AlertDeliveryChannelName,
  AlertDispatchResult,
} from './channel.js';
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

interface DispatchOptions {
  channels?: AlertDeliveryChannelName[];
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

  getEnabledChannels(tier: PromotedAlert['deliveryTier']): AlertDeliveryChannelName[] {
    return this.channels
      .filter((channel) => channel.isEnabledForTier(tier))
      .map((channel) => channel.name);
  }

  async dispatch(alert: PromotedAlert, options: DispatchOptions = {}): Promise<AlertDispatchResult> {
    const requestedChannels = options.channels ?? null;
    const enabledChannels = this.channels.filter(
      (channel) =>
        channel.isEnabledForTier(alert.deliveryTier) &&
        (requestedChannels === null || requestedChannels.includes(channel.name)),
    );

    if (this.dryRun) {
      return {
        status: 'suppressed-dry-run',
        channels: enabledChannels.map((channel) => channel.name),
        failedChannels: [],
        channelResults: enabledChannels.map<AlertChannelDispatchResult>((channel) => ({
          channel: channel.name,
          status: 'suppressed-dry-run',
          error: null,
        })),
      };
    }

    if (enabledChannels.length === 0) {
      return {
        status: 'disabled',
        channels: [],
        failedChannels: [],
        channelResults: [],
      };
    }

    const sentChannels: AlertDeliveryChannelName[] = [];
    const failedChannels: AlertDeliveryChannelName[] = [];
    const channelResults: AlertChannelDispatchResult[] = [];
    let duplicateChannels = 0;

    for (const channel of enabledChannels) {
      const dedupKey = buildAlertDedupKey(channel.name, alert);
      if (this.inFlightKeys.has(dedupKey)) {
        duplicateChannels += 1;
        channelResults.push({
          channel: channel.name,
          status: 'suppressed-duplicate',
          error: null,
        });
        continue;
      }

      this.inFlightKeys.add(dedupKey);
      try {
        if (await this.deduper.hasRecentDispatch(channel.name, alert)) {
          duplicateChannels += 1;
          channelResults.push({
            channel: channel.name,
            status: 'suppressed-duplicate',
            error: null,
          });
          continue;
        }

        try {
          await channel.dispatch(alert);
          await this.deduper.markDispatched(channel.name, alert);
          sentChannels.push(channel.name);
          channelResults.push({
            channel: channel.name,
            status: 'sent',
            error: null,
          });
        } catch (error) {
          failedChannels.push(channel.name);
          channelResults.push({
            channel: channel.name,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
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
        channelResults,
      };
    }

    if (duplicateChannels === enabledChannels.length) {
      return {
        status: 'suppressed-duplicate',
        channels: enabledChannels.map((channel) => channel.name),
        failedChannels: [],
        channelResults,
      };
    }

    return {
      status: failedChannels.length > 0 ? 'failed' : 'disabled',
      channels: [],
      failedChannels,
      channelResults,
    };
  }
}
