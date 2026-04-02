import { describe, expect, it, vi } from 'vitest';
import { createIngestQuarantineStore } from '../../../src/persistence/queries/ingest-quarantine.js';

describe('createIngestQuarantineStore', () => {
  it('writes both failure_reason and legacy error_reason when quarantining a payload', async () => {
    const createdAt = new Date('2026-04-02T05:35:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'quarantine-1',
          source: 'polymarket_rest',
          raw_payload: { foo: 'bar' },
          failure_reason: 'missing proxy wallet',
          created_at: createdAt,
        },
      ],
    });
    const store = createIngestQuarantineStore({ query });

    const entry = await store.recordFailure({
      source: 'polymarket_rest',
      rawPayload: { foo: 'bar' },
      failureReason: 'missing proxy wallet',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('error_reason');
    expect(query.mock.calls[0]?.[1]?.[3]).toBe('missing proxy wallet');
    expect(entry).toMatchObject({
      id: 'quarantine-1',
      source: 'polymarket_rest',
      failureReason: 'missing proxy wallet',
      createdAt,
    });
  });

  it('reads quarantine rows through the compatibility coalesce', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'quarantine-1',
          source: 'polymarket_rest',
          raw_payload: { foo: 'bar' },
          failure_reason: 'missing proxy wallet',
          created_at: new Date('2026-04-02T05:35:00.000Z'),
        },
      ],
    });
    const store = createIngestQuarantineStore({ query });

    const entries = await store.listRecent(10);

    expect(query.mock.calls[0]?.[0]).toContain('coalesce(failure_reason, error_reason) as failure_reason');
    expect(entries[0]?.failureReason).toBe('missing proxy wallet');
  });
});
