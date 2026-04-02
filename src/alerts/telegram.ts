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

interface TelegramDispatcherOptions {
  fetchImpl?: typeof fetch;
}

interface TelegramSendResponse {
  ok?: boolean;
  description?: string;
}

interface TelegramInlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
}

export function isTelegramEnabledForTier(
  config: Pick<AppConfig, 'telegram'>,
  tier: PromotedAlertTier,
): boolean {
  if (!config.telegram.botToken) {
    return false;
  }

  if (tier === 'CRITICAL' || tier === 'HIGH') {
    return config.telegram.criticalChatId !== null || config.telegram.mediumChatId !== null;
  }

  return config.telegram.mediumChatId !== null || config.telegram.criticalChatId !== null;
}

export class TelegramDispatcher implements AlertDeliveryChannel {
  readonly name = 'telegram' as const;
  private readonly botToken: string | null;
  private readonly criticalChatId: string | null;
  private readonly mediumChatId: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly circuitBreaker = new CircuitBreaker('telegram dispatch');

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
    return isTelegramEnabledForTier(
      {
        telegram: {
          botToken: this.botToken,
          criticalChatId: this.criticalChatId,
          mediumChatId: this.mediumChatId,
        },
      },
      tier,
    );
  }

  async dispatch(alert: PresentableAlert): Promise<void> {
    if (!this.botToken) {
      throw new Error('Telegram bot token is not configured');
    }

    const chatId = this.resolveChatId(alert.deliveryTier);
    if (!chatId) {
      throw new Error(`No Telegram chat is configured for ${alert.deliveryTier} alerts`);
    }

    const response = await this.circuitBreaker.execute(async () =>
      this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          text: formatTelegramAlertMessage(alert),
          reply_markup: buildTelegramInlineKeyboard(alert),
        }),
      }),
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

export function formatTelegramAlertMessage(alert: PresentableAlert): string {
  const marketText = alert.marketUrl
    ? `<a href="${escapeTelegramHtmlAttribute(alert.marketUrl)}">${escapeTelegramHtml(alert.marketQuestion)}</a>`
    : escapeTelegramHtml(alert.marketQuestion);
  const walletUrl = buildPolygonscanAddressUrl(alert.walletAddress);
  const meaningLine = formatAlertMeaning(alert);
  const contextLine =
    alert.linkedTradeContext === null || alert.linkedTradeContext === undefined
      ? null
      : `<b>Context</b>: ${escapeTelegramHtml(formatLinkedTradeContextSummary(alert.linkedTradeContext))}`;

  return [
    `<b>${escapeTelegramHtml(formatAlertHeadline(alert.deliveryTier, alert.signal.signalId))}</b>`,
    marketText,
    ...(meaningLine ? [`<i>${escapeTelegramHtml(meaningLine)}</i>`] : []),
    '',
    `<b>Action</b>: ${escapeTelegramHtml(formatAlertTradeAction(alert))}`,
    `<b>Fill</b>: $${escapeTelegramHtml(formatAlertFillSize(alert))}`,
    `<b>Score</b>: ${escapeTelegramHtml(formatAlertScore(alert))}`,
    `<b>Wallet</b>: <a href="${escapeTelegramHtmlAttribute(walletUrl)}">${escapeTelegramHtml(formatAlertShortWallet(alert.walletAddress))}</a>`,
    ...(contextLine ? [contextLine] : []),
  ].join('\n');
}

function buildTelegramInlineKeyboard(alert: PresentableAlert): TelegramInlineKeyboardMarkup {
  const walletUrl = buildPolygonscanAddressUrl(alert.walletAddress);
  const buttons = alert.marketUrl
    ? [
        { text: 'Market', url: alert.marketUrl },
        { text: 'Wallet', url: walletUrl },
      ]
    : [{ text: 'Wallet', url: walletUrl }];

  return {
    inline_keyboard: [buttons],
  };
}

function escapeTelegramHtml(value: string): string {
  return sanitizeText(value, {
    preserveNewlines: false,
  })
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeTelegramHtmlAttribute(value: string): string {
  return escapeTelegramHtml(value);
}
