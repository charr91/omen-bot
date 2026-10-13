import { describe, expect, it } from 'vitest';
import { deriveWalletAge, mergeProxyAndController } from '../../../src/profiling/wallet-age.js';
import type { WalletChainProfile } from '../../../src/types/wallet.js';

const fillAt = new Date('2026-10-13T00:01:48Z');
const H = 3_600_000;
const unknown: WalletChainProfile = {
  ageSeconds: 0, activityAgeKnown: false, totalTransactions: 0, isContract: true, controllerAddress: '0xc',
  freshnessAgeSeconds: 0, freshnessActivityAgeKnown: false, freshnessTotalTransactions: 0, firstActivityAt: null,
};
const known = (first: Date, tx = 0): WalletChainProfile => ({
  ...unknown, activityAgeKnown: true, freshnessActivityAgeKnown: true, firstActivityAt: first, totalTransactions: tx,
  freshnessTotalTransactions: tx, ageSeconds: Math.floor((fillAt.getTime() - first.getTime()) / 1000),
});

describe('deriveWalletAge', () => {
  it('uses the earliest of chain first transfer, funding edges and first-seen fill, and counts prior fills/deposits', () => {
    const age = deriveWalletAge({
      chain: known(new Date(fillAt.getTime() - 2 * H)), fundingFirstAt: new Date('2026-10-12T00:22:17Z'),
      fundingInboundCount: 1, firstSeenAt: new Date('2026-10-11T15:43:55Z'), priorFills: 2, now: fillAt, freshWindowHours: 72,
    });
    expect(age.activityAgeKnown).toBe(true);
    expect(age.firstActivityAt?.toISOString()).toBe('2026-10-11T15:43:55.000Z');
    expect(age.ageSeconds).toBe(Math.floor((fillAt.getTime() - Date.parse('2026-10-11T15:43:55Z')) / 1000));
    expect(age.totalTransactions).toBe(2);
  });

  it('does not call a wallet fresh on missing data: no chain history -> age unknown', () => {
    const age = deriveWalletAge({ chain: unknown, fundingFirstAt: new Date(fillAt.getTime() - H), fundingInboundCount: 1,
      firstSeenAt: fillAt, priorFills: 1, now: fillAt, freshWindowHours: 72 });
    expect(age.activityAgeKnown).toBe(false);
    expect(age.ageSeconds).toBe(0);
  });

  it('partial evidence older than the fresh window proves the wallet is not fresh', () => {
    const age = deriveWalletAge({ chain: unknown, fundingFirstAt: null, fundingInboundCount: 0,
      firstSeenAt: new Date(fillAt.getTime() - 100 * H), priorFills: 5, now: fillAt, freshWindowHours: 72 });
    expect(age).toMatchObject({ activityAgeKnown: true, ageSeconds: 100 * 3600 });
  });
});

describe('mergeProxyAndController', () => {
  it("keeps the proxy's own first transfer when the gasless controller has no history", () => {
    const merged = mergeProxyAndController(known(new Date('2026-10-11T15:00:00Z'), 0), unknown, '0xc');
    expect(merged).toMatchObject({ activityAgeKnown: true, controllerAddress: '0xc', isContract: true });
    expect(merged.firstActivityAt?.toISOString()).toBe('2026-10-11T15:00:00.000Z');
    expect(mergeProxyAndController(unknown, unknown, '0xc').activityAgeKnown).toBe(false);
  });
});
