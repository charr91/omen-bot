import { describe, expect, it, vi } from 'vitest';
import { AlertDispatcher, legacyChannelsDisabled } from '../../../src/alerts/dispatcher.js';

const feedOn = {
  enabled: true,
  databaseUrl: 'postgres://feed@127.0.0.1/smart_money_feed',
  publishLiveAlerts: true,
  syncOutcomes: true,
  disableLegacyChannels: true,
};

function makeDispatcher(feed: typeof feedOn | undefined, fetchImpl = vi.fn()) {
  return new AlertDispatcher(
    {
      alerts: {
        criticalMinScore: 80,
        highMinScore: 60,
        mediumMinScore: 40,
        lowMinScore: 20,
        dedupCooldownMs: 60_000,
        dedupScoreIncrease: 10,
      },
      operational: { dryRun: false },
      telegram: { botToken: 'bot-token', criticalChatId: 'critical-chat', mediumChatId: 'medium-chat' },
      discord: { criticalWebhookUrl: 'https://discord.example/hook', mediumWebhookUrl: null },
      ...(feed ? { feed } : {}),
    } as ConstructorParameters<typeof AlertDispatcher>[0],
    { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') },
    { fetchImpl },
  );
}

describe('feed.disable_legacy_channels', () => {
  it('only applies when the feed is really the live delivery path', () => {
    expect(legacyChannelsDisabled(feedOn)).toBe(true);
    expect(legacyChannelsDisabled({ ...feedOn, disableLegacyChannels: false })).toBe(false);
    expect(legacyChannelsDisabled({ ...feedOn, enabled: false })).toBe(false);
    expect(legacyChannelsDisabled({ ...feedOn, databaseUrl: null })).toBe(false);
    expect(legacyChannelsDisabled({ ...feedOn, publishLiveAlerts: false })).toBe(false);
    expect(legacyChannelsDisabled(undefined)).toBe(false);
  });

  it('drops Telegram and Discord when on, and never calls out', async () => {
    const fetchImpl = vi.fn();
    const dispatcher = makeDispatcher(feedOn, fetchImpl);
    expect(dispatcher.getEnabledChannels('critical')).toEqual([]);
    expect(makeDispatcher({ ...feedOn, disableLegacyChannels: false }).getEnabledChannels('critical')).toEqual([
      'telegram',
      'discord',
    ]);
    expect(makeDispatcher(undefined).getEnabledChannels('critical')).toEqual(['telegram', 'discord']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
