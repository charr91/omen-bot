import { describe, expect, it, vi } from 'vitest';
import { RedisAlertDeduper, buildAlertDedupKey } from '../../../src/alerts/dedup.js';
import type { PromotedAlert } from '../../../src/types/alert.js';
import { SignalId } from '../../../src/types/signal.js';

function makeAlert(): PromotedAlert {
  return {
    fillId: 'fill-1',
    walletAddress: '0xabc',
    marketId: 'market-1',
    marketQuestion: 'Will X happen?',
    walletLiveScore: 52,
    walletLiveTier: 'MEDIUM',
    deliveryTier: 'MEDIUM',
    signal: {
      signalId: SignalId.OUTSIZED_POSITION,
      availability: 'LIVE',
      score: 12,
      confidence: 0.8,
      evidence: [],
      triggeredAt: new Date('2026-03-31T02:00:00.000Z'),
    },
    promotedAt: '2026-03-31T02:01:00.000Z',
    dryRun: false,
  };
}

describe('RedisAlertDeduper', () => {
  it('builds market-scoped dedup keys', () => {
    expect(buildAlertDedupKey(makeAlert())).toBe('omen:dedup:market-1:0xabc:OUTSIZED_POSITION');
  });

  it('marks dispatched alerts with a cooldown TTL', async () => {
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('2026-03-31T02:01:00.000Z');
    const set = vi.fn().mockResolvedValue('OK');
    const deduper = new RedisAlertDeduper({ get, set }, 60_000);
    const alert = makeAlert();

    await expect(deduper.hasRecentDispatch(alert)).resolves.toBe(false);
    await deduper.markDispatched(alert, new Date('2026-03-31T02:01:00.000Z'));
    await expect(deduper.hasRecentDispatch(alert)).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith(
      'omen:dedup:market-1:0xabc:OUTSIZED_POSITION',
      '2026-03-31T02:01:00.000Z',
      'PX',
      60_000,
    );
  });
});
