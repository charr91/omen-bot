import { describe, expect, it, vi } from 'vitest';
import { createAlertStore } from '../../../src/persistence/queries/alerts.js';
import type { PromotedAlert } from '../../../src/types/alert.js';
import { SignalId } from '../../../src/types/signal.js';

function makeAlert(overrides: Partial<PromotedAlert> = {}): PromotedAlert {
  return {
    fillId: 'fill-1',
    walletAddress: '0xAbC123',
    marketId: 'market-1',
    marketQuestion: 'Will X happen?',
    walletLiveScore: 42,
    walletLiveTier: 'MEDIUM',
    deliveryTier: 'MEDIUM',
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
    promotedAlertId: 'alert-1',
    promotedAt: '2026-03-31T02:01:00.000Z',
    dryRun: false,
    ...overrides,
  };
}

describe('createAlertStore', () => {
  it('upserts promoted alerts with canonical wallet addresses and serialized evidence', async () => {
    const promotedAt = new Date('2026-03-31T02:01:00.000Z');
    const createdAt = new Date('2026-03-31T02:01:05.000Z');
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'alert-1',
          wallet_address: '0xabc123',
          market_id: 'market-1',
          fill_id: 'fill-1',
          signal_id: SignalId.OUTSIZED_POSITION,
          signal_availability: 'LIVE',
          signal_score: 12,
          signal_confidence: 0.8,
          signal_evidence: makeAlert().signal.evidence,
          signal_triggered_at: new Date('2026-03-31T02:00:00.000Z'),
          market_question: 'Will X happen?',
          wallet_live_score: 42,
          wallet_live_tier: 'MEDIUM',
          delivery_tier: 'MEDIUM',
          dry_run: false,
          dispatch_eligible: true,
          promoted_at: promotedAt,
          created_at: createdAt,
        },
      ],
    });
    const store = createAlertStore({ query });

    const alert = await store.upsertPromotedAlert(makeAlert(), true);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]?.[1]).toBe('0xabc123');
    expect(query.mock.calls[0]?.[1]?.[8]).toBe(JSON.stringify(makeAlert().signal.evidence));
    expect(query.mock.calls[0]?.[1]?.[16]).toBe(true);
    expect(alert).toMatchObject({
      id: 'alert-1',
      walletAddress: '0xabc123',
      promotedAlertId: 'alert-1',
      promotedAt: promotedAt.toISOString(),
      createdAt: createdAt.toISOString(),
      dispatchEligible: true,
    });
  });

  it('lists pending alerts with delivered channel state', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'alert-1',
          wallet_address: '0xabc123',
          market_id: 'market-1',
          fill_id: 'fill-1',
          signal_id: SignalId.OUTSIZED_POSITION,
          signal_availability: 'LIVE',
          signal_score: 12,
          signal_confidence: 0.8,
          signal_evidence: [],
          signal_triggered_at: new Date('2026-03-31T02:00:00.000Z'),
          market_question: 'Will X happen?',
          wallet_live_score: 42,
          wallet_live_tier: 'MEDIUM',
          delivery_tier: 'MEDIUM',
          dry_run: false,
          dispatch_eligible: true,
          promoted_at: new Date('2026-03-31T02:01:00.000Z'),
          created_at: new Date('2026-03-31T02:01:05.000Z'),
          delivered_channels: ['telegram'],
        },
      ],
    });
    const store = createAlertStore({ query });

    await expect(store.listPendingDispatchAlerts(10)).resolves.toEqual([
      expect.objectContaining({
        id: 'alert-1',
        deliveredChannels: ['telegram'],
      }),
    ]);
  });

  it('records one delivery row per channel result and stamps terminal delivery time only for terminal statuses', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const store = createAlertStore({ query });
    const attemptedAt = new Date('2026-03-31T02:03:00.000Z');

    await store.recordDispatchResult(
      'alert-1',
      {
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
      },
      attemptedAt,
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]?.[1]).toBe('alert-1');
    expect(query.mock.calls[0]?.[1]?.[2]).toBe('telegram');
    expect(query.mock.calls[0]?.[1]?.[3]).toBe('sent');
    expect(query.mock.calls[0]?.[1]?.[6]).toEqual(attemptedAt);
    expect(query.mock.calls[1]?.[1]?.[2]).toBe('discord');
    expect(query.mock.calls[1]?.[1]?.[3]).toBe('failed');
    expect(query.mock.calls[1]?.[1]?.[4]).toBe('discord webhook unavailable');
    expect(query.mock.calls[1]?.[1]?.[6]).toBeNull();
  });
});
