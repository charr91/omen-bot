import type { AppConfig } from '../config/schema.js';
import type { PromotedAlert } from '../types/alert.js';
import { SignalId } from '../types/signal.js';
import { TelegramDispatcher } from './telegram.js';

export async function sendTestTelegramAlert(
  config: Pick<AppConfig, 'telegram'>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PromotedAlert> {
  const alert = buildTestTelegramAlert();
  const dispatcher = new TelegramDispatcher(config, options);
  await dispatcher.dispatch(alert);
  return alert;
}

function buildTestTelegramAlert(): PromotedAlert {
  return {
    fillId: 'test-telegram-fill',
    walletAddress: '0x0000000000000000000000000000000000000001',
    marketId: 'test-telegram-market',
    marketQuestion: 'Test Telegram alert from Omen',
    walletLiveScore: 72,
    walletLiveTier: 'HIGH',
    deliveryTier: 'HIGH',
    signal: {
      signalId: SignalId.OUTSIZED_POSITION,
      availability: 'LIVE',
      score: 72,
      confidence: 1,
      evidence: [
        {
          field: 'fill_size_usd',
          value: 1234.56,
          threshold: 1000,
          description: 'Synthetic test fill size',
        },
      ],
      triggeredAt: new Date(),
    },
    promotedAlertId: null,
    promotedAt: new Date().toISOString(),
    dryRun: false,
  };
}
