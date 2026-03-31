import { describe, expect, it, vi } from 'vitest';
import { createWalletStore } from '../../../src/persistence/queries/wallets.js';
import type { WalletProfile } from '../../../src/types/wallet.js';

function makeProfile(overrides: Partial<WalletProfile> = {}): WalletProfile {
  return {
    address: '0xAbC123',
    ageSeconds: 3600,
    activityAgeKnown: true,
    totalTransactions: 2,
    isContract: false,
    controllerAddress: '0xDeF456',
    firstSeenAt: new Date('2026-03-30T00:00:00.000Z'),
    lastActiveAt: new Date('2026-03-30T00:10:00.000Z'),
    totalMarkets: 1,
    totalFills: 1,
    totalVolumeUsd: '1000.000000',
    liveSuspicionScore: 12,
    liveTier: 'LOW',
    isWhitelisted: false,
    ...overrides,
  };
}

describe('createWalletStore', () => {
  it('canonicalizes wallet addresses for writes and case-insensitive lookups', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ total_fills: '2', total_markets: '1', total_volume_usd: '42.000000' }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ exists: true }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const store = createWalletStore({ query });

    await store.upsertWalletStub('0xAbC123', new Date('2026-03-30T00:00:00.000Z'));
    await expect(store.getAggregateStats('0xAbC123')).resolves.toEqual({
      totalFills: 2,
      totalMarkets: 1,
      totalVolumeUsd: '42.000000',
    });
    await expect(store.isWhitelisted('0xAbC123')).resolves.toBe(true);
    await store.upsertLiveProfile(makeProfile());

    expect(query.mock.calls[0]?.[1]?.[0]).toBe('0xabc123');
    expect(query.mock.calls[1]?.[0]).toContain('where lower(wallet_address) = $1');
    expect(query.mock.calls[1]?.[1]?.[0]).toBe('0xabc123');
    expect(query.mock.calls[2]?.[0]).toContain('where lower(wallet_address) = $1');
    expect(query.mock.calls[2]?.[1]?.[0]).toBe('0xabc123');
    expect(query.mock.calls[3]?.[1]?.[0]).toBe('0xabc123');
    expect(query.mock.calls[3]?.[1]?.[5]).toBe('0xdef456');
  });
});
