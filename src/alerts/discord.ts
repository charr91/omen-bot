import type { AppConfig } from '../config/schema.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { sanitizeText } from '../resilience/sanitizer.js';
import type { PresentableAlert, PromotedAlertTier } from '../types/alert.js';
import type { AlertDeliveryChannel } from './channel.js';
import { buildPolygonscanAddressUrl } from './links.js';
import {
  formatAlertFillSize,
  formatAlertHeadline,
  formatAlertMeaning,
  formatAlertScore,
  formatAlertShortWallet,
  formatAlertTradeAction,
  formatLinkedTradeContextSummary,
} from './presentation.js';

interface DiscordDispatcherOptions {
  fetchImpl?: typeof fetch;
}

export function isDiscordEnabledForTier(
  config: Pick<AppConfig, 'discord'>,
  tier: PromotedAlertTier,
): boolean {
  if (tier === 'CRITICAL' || tier === 'HIGH') {
    return config.discord.criticalWebhookUrl !== null || config.discord.mediumWebhookUrl !== null;
  }

  return config.discord.mediumWebhookUrl !== null || config.discord.criticalWebhookUrl !== null;
}

export class DiscordDispatcher implements AlertDeliveryChannel {
  readonly name = 'discord' as const;
  private readonly criticalWebhookUrl: string | null;
  private readonly mediumWebhookUrl: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly circuitBreaker = new CircuitBreaker('discord dispatch');

  constructor(config: Pick<AppConfig, 'discord'>, options: DiscordDispatcherOptions = {}) {
    this.criticalWebhookUrl = config.discord.criticalWebhookUrl;
    this.mediumWebhookUrl = config.discord.mediumWebhookUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isEnabledForTier(tier: PromotedAlertTier): boolean {
    return isDiscordEnabledForTier(
      {
        discord: {
          criticalWebhookUrl: this.criticalWebhookUrl,
          mediumWebhookUrl: this.mediumWebhookUrl,
        },
      },
      tier,
    );
  }

  async dispatch(alert: PresentableAlert): Promise<void> {
    const webhookUrl = this.resolveWebhookUrl(alert.deliveryTier);
    if (!webhookUrl) {
      throw new Error(`No Discord webhook is configured for ${alert.deliveryTier} alerts`);
    }

    const response = await this.circuitBreaker.execute(async () =>
      this.fetchImpl(webhookUrl, {
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
      }),
    );

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

export function formatDiscordAlertMessage(alert: PresentableAlert): string {
  const walletUrl = buildPolygonscanAddressUrl(alert.walletAddress);
  const meaningLine = formatAlertMeaning(alert);
  const links = alert.marketUrl
    ? `Market <${alert.marketUrl}> | Wallet <${walletUrl}>`
    : `Wallet <${walletUrl}>`;

  return [
    `**${escapeDiscordMarkdown(formatAlertHeadline(alert.deliveryTier, alert.signal.signalId))}**`,
    `**Market**: ${escapeDiscordMarkdown(alert.marketQuestion)}`,
    ...(meaningLine ? [`*${escapeDiscordMarkdown(meaningLine)}*`] : []),
    '',
    `**Action**: ${escapeDiscordMarkdown(formatAlertTradeAction(alert))}`,
    `**Fill**: $${escapeDiscordMarkdown(formatAlertFillSize(alert))}`,
    `**Score**: ${escapeDiscordMarkdown(formatAlertScore(alert))}`,
    `**Wallet**: \`${escapeDiscordCode(formatAlertShortWallet(alert.walletAddress))}\``,
    `**Quick links**: ${links}`,
    ...(alert.linkedTradeContext
      ? ['', `**Context**: ${escapeDiscordMarkdown(formatLinkedTradeContextSummary(alert.linkedTradeContext))}`]
      : []),
  ].join('\n');
}

function escapeDiscordMarkdown(value: string): string {
  return suppressDiscordMentions(
    sanitizeText(value, {
      preserveNewlines: false,
    }),
  )
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('~', '\\~')
    .replaceAll('`', '\\`')
    .replaceAll('|', '\\|')
    .replaceAll('>', '\\>');
}

function escapeDiscordCode(value: string): string {
  return suppressDiscordMentions(
    sanitizeText(value, {
      preserveNewlines: false,
    }),
  ).replaceAll('`', '\\`');
}

function suppressDiscordMentions(value: string): string {
  return value
    .replaceAll('@everyone', '@\u200beveryone')
    .replaceAll('@here', '@\u200bhere')
    .replaceAll('<@', '<\u200b@')
    .replaceAll('<#', '<\u200b#');
}
