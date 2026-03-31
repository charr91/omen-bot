import type { AppConfig } from '../config/schema.js';
import type { PromotedAlert, PromotedAlertTier } from '../types/alert.js';
import type { AlertDeliveryChannel } from './channel.js';

interface DiscordDispatcherOptions {
  fetchImpl?: typeof fetch;
}

export class DiscordDispatcher implements AlertDeliveryChannel {
  readonly name = 'discord' as const;
  private readonly criticalWebhookUrl: string | null;
  private readonly mediumWebhookUrl: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Pick<AppConfig, 'discord'>, options: DiscordDispatcherOptions = {}) {
    this.criticalWebhookUrl = config.discord.criticalWebhookUrl;
    this.mediumWebhookUrl = config.discord.mediumWebhookUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isEnabledForTier(tier: PromotedAlertTier): boolean {
    return this.resolveWebhookUrl(tier) !== null;
  }

  async dispatch(alert: PromotedAlert): Promise<void> {
    const webhookUrl = this.resolveWebhookUrl(alert.deliveryTier);
    if (!webhookUrl) {
      throw new Error(`No Discord webhook is configured for ${alert.deliveryTier} alerts`);
    }

    const response = await this.fetchImpl(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: formatDiscordAlertMessage(alert),
        allowed_mentions: {
          parse: [],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}`);
    }
  }

  private resolveWebhookUrl(tier: PromotedAlertTier): string | null {
    if (tier === 'CRITICAL' || tier === 'HIGH') {
      return this.criticalWebhookUrl ?? this.mediumWebhookUrl;
    }

    return this.mediumWebhookUrl ?? this.criticalWebhookUrl;
  }
}

export function formatDiscordAlertMessage(alert: PromotedAlert): string {
  const fillSize = alert.signal.evidence.find((entry) => entry.field === 'fill_size_usd')?.value ?? 'n/a';

  return [
    `**${escapeDiscordMarkdown(alert.deliveryTier)} OMEN alert**`,
    `**Signal**: \`${escapeDiscordCode(alert.signal.signalId)}\``,
    `**Market**: ${escapeDiscordMarkdown(alert.marketQuestion)}`,
    `**Wallet**: \`${escapeDiscordCode(alert.walletAddress)}\``,
    `**Live score**: ${alert.walletLiveScore} (${escapeDiscordMarkdown(alert.walletLiveTier)})`,
    `**Fill size**: $${escapeDiscordMarkdown(String(fillSize))}`,
  ].join('\n');
}

function escapeDiscordMarkdown(value: string): string {
  return suppressDiscordMentions(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('~', '\\~')
    .replaceAll('`', '\\`')
    .replaceAll('|', '\\|')
    .replaceAll('>', '\\>');
}

function escapeDiscordCode(value: string): string {
  return suppressDiscordMentions(value).replaceAll('`', '\\`');
}

function suppressDiscordMentions(value: string): string {
  return value.replaceAll('@everyone', '@\u200beveryone').replaceAll('@here', '@\u200bhere');
}
