import { describe, expect, it, vi } from 'vitest';
import { parseEnvelope } from '@charr91/smart-money-feed';
import { liveAlertEnvelope, severityForTier, syncOutcomesToFeed } from '../../../src/feed/publisher.js';

describe('omen -> feed', () => {
  it('maps a stored alert to a valid deliverable envelope keyed by fill id', () => {
    const envelope = parseEnvelope(
      liveAlertEnvelope({
        id: 'a1', fillId: 'f1', walletAddress: '0xw', marketId: '0xm', marketQuestion: 'Q?', marketUrl: 'https://polymarket.com/event/q',
        fillSide: 'SELL', fillOutcome: 'YES', fillPrice: '0.3', fillSizeUsd: '1500', fillTimestamp: '2026-10-12T20:00:00Z',
        walletLiveScore: 61.4, walletLiveTier: 'HIGH', signal: { signalId: 'LUMP_ENTRY' } as never, promotedAlertId: 'a1',
        promotedAt: '2026-10-12T20:00:01Z', dryRun: true, deliveryTier: 'HIGH', dispatchEligible: false, createdAt: '',
      } as never),
    );
    expect(envelope).toMatchObject({ alertKey: 'f1', direction: 'short', priceAtAlert: 0.3, severity: 'high', deliver: true });
    expect(severityForTier(null)).toBe('info');
  });

  it('syncs outcome rows (baseline inherits ref signals) and marks them synced', async () => {
    const rows = [
      { fill_id: 'f1', kind: 'signal', ref_fill_id: null, signal_ids: ['A'], delivery_tier: 'MEDIUM', venue: 'polymarket', market_id: 'm', token_id: 't',
        side: 'BUY', size_usd: '600', alert_at: new Date(), price_at_alert: '0.4', price_1h: '0.45', price_24h: null, resolution_price: null },
      { fill_id: 'kalshi:x', kind: 'signal', ref_fill_id: null, signal_ids: ['KALSHI_BLOCK_TRADE'], delivery_tier: 'KALSHI', venue: 'kalshi', market_id: 'KX-1',
        token_id: 'KX-1', side: 'SELL', size_usd: '0', alert_at: new Date(), price_at_alert: '0.6', price_1h: null, price_24h: null, resolution_price: '0' },
    ];
    const query = vi.fn(async (sql: string) => (sql.includes('from trade_outcomes o') ? { rows } : { rows: [] }));
    const feed = { publish: vi.fn(async () => ({})), recordOutcome: vi.fn(async () => true) };
    expect(await syncOutcomesToFeed({ query } as never, feed as never)).toBe(2);
    const [[first], [second]] = feed.publish.mock.calls as unknown as [[Record<string, any>], [Record<string, any>]];
    expect(parseEnvelope(first)).toMatchObject({ venue: 'polymarket', subject: { instrumentId: 't' }, severity: 'medium', deliver: false });
    expect(parseEnvelope(second)).toMatchObject({ venue: 'kalshi', direction: 'short', severity: 'info' });
    expect(feed.recordOutcome).toHaveBeenCalledWith('omen', 'f1', { price1h: 0.45, price24h: null, resolutionPrice: null });
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith('update trade_outcomes'))).toHaveLength(2);
  });
});
