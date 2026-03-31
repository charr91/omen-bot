import { describe, expect, it, vi } from 'vitest';
import { AlertDispatcher } from '../../../src/alerts/dispatcher.js';
import { TelegramDispatcher, formatTelegramAlertMessage } from '../../../src/alerts/telegram.js';
import type { PromotedAlert } from '../../../src/types/alert.js';
import { SignalId } from '../../../src/types/signal.js';

function makeAlert(): PromotedAlert {
  return {
    fillId: 'fill-1',
    walletAddress: '0xabc',
    marketId: 'market-1',
    marketQuestion: 'Will "<X>" & Y happen?',
    walletLiveScore: 62,
    walletLiveTier: 'HIGH',
    deliveryTier: 'HIGH',
    signal: {
      signalId: SignalId.OUTSIZED_POSITION,
      availability: 'LIVE',
      score: 12,
      confidence: 0.8,
      evidence: [
        {
          field: 'fill_size_usd',
          value: 1234,
          threshold: 1000,
          description: 'threshold',
        },
      ],
      triggeredAt: new Date('2026-03-31T02:00:00.000Z'),
    },
    promotedAlertId: null,
    promotedAt: '2026-03-31T02:01:00.000Z',
    dryRun: false,
  };
}

describe('Telegram alert delivery', () => {
  it('formats escaped HTML messages', () => {
    const message = formatTelegramAlertMessage(makeAlert());
    expect(message).toContain('Will &quot;&lt;X&gt;&quot; &amp; Y happen?');
    expect(message).toContain('<code>OUTSIZED_POSITION</code>');
  });

  it('suppresses Telegram sends in dry-run mode', async () => {
    const fetchImpl = vi.fn();
    const dispatch = new AlertDispatcher(
      {
        alerts: {
          criticalMinScore: 80,
          highMinScore: 60,
          mediumMinScore: 40,
          lowMinScore: 20,
          dedupCooldownMs: 60_000,
        },
        operational: {
          dryRun: true,
        },
        telegram: {
          botToken: 'bot-token',
          criticalChatId: 'critical-chat',
          mediumChatId: 'medium-chat',
        },
        discord: {
          criticalWebhookUrl: null,
          mediumWebhookUrl: null,
        },
      },
      {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
      },
      { fetchImpl },
    );

    await expect(dispatch.dispatch(makeAlert())).resolves.toEqual({
      status: 'suppressed-dry-run',
      channels: ['telegram'],
      failedChannels: [],
      channelResults: [
        {
          channel: 'telegram',
          status: 'suppressed-dry-run',
          error: null,
        },
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends HIGH alerts to the critical chat and marks dedup on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const dispatch = new AlertDispatcher(
      {
        alerts: {
          criticalMinScore: 80,
          highMinScore: 60,
          mediumMinScore: 40,
          lowMinScore: 20,
          dedupCooldownMs: 60_000,
        },
        operational: {
          dryRun: false,
        },
        telegram: {
          botToken: 'bot-token',
          criticalChatId: 'critical-chat',
          mediumChatId: 'medium-chat',
        },
        discord: {
          criticalWebhookUrl: null,
          mediumWebhookUrl: null,
        },
      },
      redis,
      { fetchImpl },
    );

    await expect(dispatch.dispatch(makeAlert())).resolves.toEqual({
      status: 'sent',
      channels: ['telegram'],
      failedChannels: [],
      channelResults: [
        {
          channel: 'telegram',
          status: 'sent',
          error: null,
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
    });
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('treats already-deduped alerts as suppressed duplicates', async () => {
    const fetchImpl = vi.fn();
    const dispatch = new AlertDispatcher(
      {
        alerts: {
          criticalMinScore: 80,
          highMinScore: 60,
          mediumMinScore: 40,
          lowMinScore: 20,
          dedupCooldownMs: 60_000,
        },
        operational: {
          dryRun: false,
        },
        telegram: {
          botToken: 'bot-token',
          criticalChatId: 'critical-chat',
          mediumChatId: 'medium-chat',
        },
        discord: {
          criticalWebhookUrl: null,
          mediumWebhookUrl: null,
        },
      },
      {
        get: vi.fn().mockResolvedValue('2026-03-31T02:01:00.000Z'),
        set: vi.fn().mockResolvedValue('OK'),
      },
      { fetchImpl },
    );

    await expect(dispatch.dispatch(makeAlert())).resolves.toEqual({
      status: 'suppressed-duplicate',
      channels: ['telegram'],
      failedChannels: [],
      channelResults: [
        {
          channel: 'telegram',
          status: 'suppressed-duplicate',
          error: null,
        },
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('suppresses concurrent same-key dispatch attempts while the dedup lookup is in flight', async () => {
    let resolveGet: ((value: string | null) => void) | null = null;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const dispatch = new AlertDispatcher(
      {
        alerts: {
          criticalMinScore: 80,
          highMinScore: 60,
          mediumMinScore: 40,
          lowMinScore: 20,
          dedupCooldownMs: 60_000,
        },
        operational: {
          dryRun: false,
        },
        telegram: {
          botToken: 'bot-token',
          criticalChatId: 'critical-chat',
          mediumChatId: 'medium-chat',
        },
        discord: {
          criticalWebhookUrl: null,
          mediumWebhookUrl: null,
        },
      },
      {
        get: vi.fn().mockImplementation(
          () =>
            new Promise<string | null>((resolve) => {
              resolveGet = resolve;
            }),
        ),
        set: vi.fn().mockResolvedValue('OK'),
      },
      { fetchImpl },
    );

    const firstDispatch = dispatch.dispatch(makeAlert());
    await Promise.resolve();

    await expect(dispatch.dispatch(makeAlert())).resolves.toEqual({
      status: 'suppressed-duplicate',
      channels: ['telegram'],
      failedChannels: [],
      channelResults: [
        {
          channel: 'telegram',
          status: 'suppressed-duplicate',
          error: null,
        },
      ],
    });

    resolveGet?.(null);
    await expect(firstDispatch).resolves.toEqual({
      status: 'sent',
      channels: ['telegram'],
      failedChannels: [],
      channelResults: [
        {
          channel: 'telegram',
          status: 'sent',
          error: null,
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the medium chat when a high-severity chat is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const dispatcher = new TelegramDispatcher(
      {
        telegram: {
          botToken: 'bot-token',
          criticalChatId: null,
          mediumChatId: 'medium-chat',
        },
      },
      { fetchImpl },
    );

    await dispatcher.dispatch(makeAlert());
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.chat_id).toBe('medium-chat');
  });
});
