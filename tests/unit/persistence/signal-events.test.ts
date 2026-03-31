import { describe, expect, it, vi } from 'vitest';
import { createSignalEventStore } from '../../../src/persistence/queries/signal-events.js';
import { SignalId, type TriggeredSignal } from '../../../src/types/signal.js';

describe('createSignalEventStore', () => {
  it('serializes evidence as JSON and canonicalizes wallet addresses before inserting live signal events', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: 'signal-event-1' }],
    });
    const store = createSignalEventStore({ query });
    const signal: TriggeredSignal = {
      signalId: SignalId.OUTSIZED_POSITION,
      availability: 'LIVE',
      score: 12,
      confidence: 0.8,
      evidence: [
        {
          field: 'fill_size_usd',
          value: 1500,
          threshold: 1000,
          description: 'Large fill',
        },
      ],
      triggeredAt: new Date('2026-03-31T00:00:00.000Z'),
    };

    const inserted = await store.insertLiveSignalEvent({
      walletAddress: '0xAbC123',
      marketId: 'market-1',
      fillId: 'fill-1',
      signal,
    });

    expect(inserted).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]?.[1]).toBe('0xabc123');
    expect(query.mock.calls[0]?.[1]?.[8]).toBe(JSON.stringify(signal.evidence));
  });
});
