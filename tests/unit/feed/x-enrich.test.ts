import { describe, expect, it, vi } from 'vitest';
import { annotatePendingAlerts, marketKeywords, xRequestForAlert } from '../../../src/feed/x-enrich.js';
import type { StoredAlert } from '../../../src/types/alert.js';

function alert(tier: StoredAlert['deliveryTier'], question = 'Will Bitcoin reach $150,000 by December 31, 2026?'): StoredAlert {
  return {
    id: 'a1', fillId: 'fill-1', walletAddress: '0xw', marketId: '0xm', marketQuestion: question, fillSide: 'BUY',
    fillOutcome: 'YES', fillTimestamp: '2026-10-12T12:00:00Z', walletLiveScore: 80, walletLiveTier: tier,
    signal: { signalId: 'FRESH_WALLET' } as StoredAlert['signal'], promotedAlertId: 'a1', promotedAt: '2026-10-12T12:00:05Z',
    dryRun: true, deliveryTier: tier, dispatchEligible: true, createdAt: '2026-10-12T12:00:05Z',
  } as StoredAlert;
}

describe('marketKeywords', () => {
  it('keeps distinctive words and numbers as people write them', () => {
    expect(marketKeywords('Will Bitcoin reach $150,000 by December 31, 2026?')).toBe('Bitcoin 150k');
    expect(marketKeywords('Will the Fed cut rates by 50 bps in September?')).toBe('Fed cut rates 50');
    expect(marketKeywords('Lakers vs. Celtics: who wins on Oct 14th?')).toBe('Lakers Celtics');
    expect(marketKeywords('Will it be?')).toBeNull();
  });
});

describe('xRequestForAlert', () => {
  it('queues MEDIUM+ only, with priority by tier and a 24h window before the fill', () => {
    expect(xRequestForAlert(alert('LOW'))).toBeNull();
    expect(xRequestForAlert(alert('MEDIUM'))).toMatchObject({ sourceApp: 'omen', alertKey: 'fill-1', kind: 'keywords',
      query: 'Bitcoin 150k', priority: 50, alertAt: '2026-10-12T12:00:00.000Z', since: '2026-10-11T12:00:00.000Z' });
    expect(xRequestForAlert(alert('CRITICAL'))?.priority).toBe(90);
    expect(xRequestForAlert(alert('MEDIUM'), 'HIGH')).toBeNull();
  });
});

describe('annotatePendingAlerts', () => {
  it('stores finished chatter and skips requests still in flight', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ fill_id: 'f1' }, { fill_id: 'f2' }] }).mockResolvedValue({ rows: [] });
    const bridge = {
      annotations: vi.fn().mockResolvedValue(
        new Map([
          ['f1', [{ alertKey: 'f1', status: 'done', requestId: '1', kind: 'keywords', query: 'q',
            chatter: { trend: 'rising', summary: 'X chatter rising · 5 posts' } }]],
          ['f2', [{ alertKey: 'f2', status: 'claimed', requestId: '2', kind: 'keywords', query: 'q2', chatter: null }]],
        ]),
      ),
    };
    const out = await annotatePendingAlerts({ query } as never, bridge as never);
    expect(out).toEqual([{ fillId: 'f1', status: 'done', trend: 'rising', summary: 'X chatter rising · 5 posts' }]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]?.slice(0, 4)).toEqual(['f1', 'done', 'rising', 'X chatter rising · 5 posts']);
  });
});
