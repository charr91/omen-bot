import type { AppConfig } from '../config/schema.js';
import type { PromotedAlert, PromotedAlertTier } from '../types/alert.js';
import type { AlertDeliveryChannel } from './channel.js';

interface TelegramDispatcherOptions {
  fetchImpl?: typeof fetch;
}

interface TelegramSendResponse {
  ok?: boolean;
  description?: string;
}

export class TelegramDispatcher implements AlertDeliveryChannel {
  readonly name = 'telegram' as const;
  private readonly botToken: string | null;
  private readonly criticalChatId: string | null;
  private readonly mediumChatId: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Pick<AppConfig, 'telegram'>, options: TelegramDispatcherOptions = {}) {
    this.botToken = config.telegram.botToken;
    this.criticalChatId = config.telegram.criticalChatId;
    this.mediumChatId = config.telegram.mediumChatId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isEnabled(): boolean {
    return this.botToken !== null && (this.criticalChatId !== null || this.mediumChatId !== null);
  }

  isEnabledForTier(tier: PromotedAlertTier): boolean {
    return this.botToken !== null && this.resolveChatId(tier) !== null;
  }

  async dispatch(alert: PromotedAlert): Promise<void> {
    if (!this.botToken) {
      throw new Error('Telegram bot token is not configured');
    }

    const chatId = this.resolveChatId(alert.deliveryTier);
    if (!chatId) {
      throw new Error(`No Telegram chat is configured for ${alert.deliveryTier} alerts`);
    }

    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          text: formatTelegramAlertMessage(alert),
        }),
      },
    );

    const payload = (await response.json().catch(() => null)) as TelegramSendResponse | null;
    if (!response.ok || payload?.ok !== true) {
      const description = payload?.description ?? response.statusText;
      throw new Error(`Telegram sendMessage failed: ${description}`);
    }
  }

  private resolveChatId(tier: PromotedAlertTier): string | null {
    if (tier === 'CRITICAL' || tier === 'HIGH') {
      return this.criticalChatId ?? this.mediumChatId;
    }

    return this.mediumChatId ?? this.criticalChatId;
  }
}

export function formatTelegramAlertMessage(alert: PromotedAlert): string {
  const fillSize = alert.signal.evidence.find((entry) => entry.field === 'fill_size_usd')?.value ?? 'n/a';

  return [
    `<b>${escapeTelegramHtml(alert.deliveryTier)} OMEN alert</b>`,
    `<b>Signal</b>: <code>${escapeTelegramHtml(alert.signal.signalId)}</code>`,
    `<b>Market</b>: ${escapeTelegramHtml(alert.marketQuestion)}`,
    `<b>Wallet</b>: <code>${escapeTelegramHtml(alert.walletAddress)}</code>`,
    `<b>Live score</b>: ${alert.walletLiveScore} (${escapeTelegramHtml(alert.walletLiveTier)})`,
    `<b>Fill size</b>: $${escapeTelegramHtml(String(fillSize))}`,
  ].join('\n');
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
