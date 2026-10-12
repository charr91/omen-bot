import { describe, expect, it, vi } from 'vitest';
import { AlertDispatcher } from '../../../src/alerts/dispatcher.js';
import { DiscordDispatcher, formatDiscordAlertMessage } from '../../../src/alerts/discord.js';
import type { PromotedAlert, PromotedAlertTier } from '../../../src/types/alert.js';
import { SignalId } from '../../../src/types/signal.js';

function makeAlert(): PromotedAlert {
  return {
    fillId: 'fill-1',
    walletAddress: '0xabc',
    marketId: 'market-1',
    marketQuestion: 'Will @everyone and <@&123> *really* `move`?',
    marketUrl: 'https://polymarket.com/event/election-2026/test-market',
    fillSide: 'BUY',
    fillOutcome: 'YES',
    fillPrice: '0.62',
    fillSizeUsd: '1234',
    fillTimestamp: '2026-03-31T02:00:00.000Z',
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

const TIER_CASES: Array<{
  tier: PromotedAlertTier;
  emoji: string;
}> = [
  { tier: 'CRITICAL', emoji: '🚨' },
  { tier: 'HIGH', emoji: '⚠️' },
  { tier: 'MEDIUM', emoji: '🔵' },
  { tier: 'LOW', emoji: '⚪' },
];

describe('Discord alert delivery', () => {
  it('formats Discord-safe content and suppresses mentions', () => {
    const message = formatDiscordAlertMessage(makeAlert());
    expect(message).toContain('**⚠️ HIGH \\| OUTSIZED\\_POSITION**');
    expect(message).toContain('Will @\u200beveryone and <\u200b@&123\\> \\*really\\* \\`move\\`?');
    expect(message).toContain('*This trade is unusually large for this market: $1,234 against a threshold of $1,000.*');
    expect(message).toContain('**Action**: Bought YES @ 0.62');
    expect(message).toContain('**Fill**: $1,234');
    expect(message).toContain('**Quick links**: Market <https://polymarket.com/event/election-2026/test-market> | Wallet <https://polygonscan.com/address/0xabc>');
  });

  it.each(TIER_CASES)('renders the tier emoji in Discord headlines for $tier', ({ tier, emoji }) => {
    const message = formatDiscordAlertMessage({
      ...makeAlert(),
      walletLiveTier: tier,
      deliveryTier: tier,
    });
    expect(message).toContain(`**${emoji} ${tier} \\| OUTSIZED\\_POSITION**`);
  });

  it('dispatches through the configured webhook with disabled mentions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
    });
    const dispatcher = new DiscordDispatcher(
      {
        discord: {
          criticalWebhookUrl: 'https://discord.example/critical',
          mediumWebhookUrl: 'https://discord.example/medium',
        },
      },
      { fetchImpl },
    );

    await dispatcher.dispatch(makeAlert());
    const request = fetchImpl.mock.calls[0];
    expect(request?.[0]).toBe('https://discord.example/critical');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      allowed_mentions: {
        parse: [],
      },
    });
  });

  it('fans out to both Telegram and Discord when both are configured', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('https://api.telegram.org/')) {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }

      return {
        ok: true,
        status: 204,
        statusText: 'No Content',
      };
    });
    const dispatch = new AlertDispatcher(
      {
        alerts: {
          criticalMinScore: 80,
          highMinScore: 60,
          mediumMinScore: 40,
          lowMinScore: 20,
          dedupCooldownMs: 60_000,
          dedupScoreIncrease: 10,
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
          criticalWebhookUrl: 'https://discord.example/critical',
          mediumWebhookUrl: 'https://discord.example/medium',
        },
      },
      {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
      },
      { fetchImpl },
    );

    await expect(dispatch.dispatch(makeAlert())).resolves.toEqual({
      status: 'sent',
      channels: ['telegram', 'discord'],
      failedChannels: [],
      channelResults: [
        {
          channel: 'telegram',
          status: 'sent',
          error: null,
        },
        {
          channel: 'discord',
          status: 'sent',
          error: null,
        },
      ],
    });
    // HIGH alerts go to both Telegram chats (medium + prime/critical) plus Discord.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('continues dispatching remaining channels when one channel fails', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('https://api.telegram.org/')) {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }

      throw new Error('discord webhook unavailable');
    });
    const dispatch = new AlertDispatcher(
      {
        alerts: {
          criticalMinScore: 80,
          highMinScore: 60,
          mediumMinScore: 40,
          lowMinScore: 20,
          dedupCooldownMs: 60_000,
          dedupScoreIncrease: 10,
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
          criticalWebhookUrl: 'https://discord.example/critical',
          mediumWebhookUrl: 'https://discord.example/medium',
        },
      },
      {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
      },
      { fetchImpl },
    );

    await expect(dispatch.dispatch(makeAlert())).resolves.toEqual({
      status: 'sent-partial',
      channels: ['telegram'],
      failedChannels: ['discord'],
      channelResults: [
        {
          channel: 'telegram',
          status: 'sent',
          error: null,
        },
        {
          channel: 'discord',
          status: 'failed',
          error: 'discord webhook unavailable',
        },
      ],
    });
    // HIGH alerts go to both Telegram chats (medium + prime/critical) plus Discord.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('can target only the missing channel during recovery dispatch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
    });
    const dispatch = new AlertDispatcher(
      {
        alerts: {
          criticalMinScore: 80,
          highMinScore: 60,
          mediumMinScore: 40,
          lowMinScore: 20,
          dedupCooldownMs: 60_000,
          dedupScoreIncrease: 10,
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
          criticalWebhookUrl: 'https://discord.example/critical',
          mediumWebhookUrl: 'https://discord.example/medium',
        },
      },
      {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
      },
      { fetchImpl },
    );

    await expect(dispatch.dispatch(makeAlert(), { channels: ['discord'] })).resolves.toEqual({
      status: 'sent',
      channels: ['discord'],
      failedChannels: [],
      channelResults: [
        {
          channel: 'discord',
          status: 'sent',
          error: null,
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://discord.example/critical');
  });
});
