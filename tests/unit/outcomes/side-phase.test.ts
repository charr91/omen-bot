import { describe, expect, it } from 'vitest';
import { directionalReturn, gamePhase, isHit } from '../../../src/outcomes/scoring.js';
import { buildStatsReport } from '../../../src/outcomes/stats.js';
import type { OutcomeQueryRow } from '../../../src/outcomes/store.js';

describe('side-aware scoring', () => {
  it('a SELL of YES at 0.242 wins when the YES price falls and loses when it rises (also at resolution)', () => {
    expect(isHit('SELL', 0.242, 0.115)).toBe(true);
    expect(isHit('SELL', 0.242, 0.4)).toBe(false);
    expect(isHit('SELL', 0.242, 0)).toBe(true);
    expect(isHit('SELL', 0.242, 1)).toBe(false);
    expect(directionalReturn('SELL', 0.242, 0)).toBeCloseTo(0.242);
    expect(isHit('BUY', 0.242, 0.115)).toBe(false);
  });
});

describe('game phase', () => {
  const kickoff = new Date('2026-10-13T00:00:00Z');
  it('labels pre-game, in-play, non-game and unknown', () => {
    expect(gamePhase(true, kickoff, new Date('2026-10-13T00:01:48Z'))).toBe('in-play');
    expect(gamePhase(true, kickoff, new Date('2026-10-12T23:00:00Z'))).toBe('pre-game');
    expect(gamePhase(true, null, kickoff)).toBe('non-game');
    expect(gamePhase(false, null, kickoff)).toBe('unknown');
  });

  it('splits stats by signal and phase, comparing each phase with its own baselines', () => {
    const row = (kind: 'signal' | 'baseline', phase: OutcomeQueryRow['phase'], later: number): OutcomeQueryRow => ({
      group: '', kind, side: 'SELL', priceAtAlert: 0.3, price1h: later, price24h: null, resolutionPrice: null,
      signalIds: ['FRESH_WALLET_LARGE_POSITION'], deliveryTier: 'HIGH', phase,
    });
    const report = buildStatsReport([
      row('signal', 'in-play', 0.1), row('baseline', 'in-play', 0.5),
      row('signal', 'pre-game', 0.5), row('baseline', 'pre-game', 0.1),
    ]);
    const byGroup = Object.fromEntries(report.bySignalPhase.map((g) => [g.group, g]));
    expect(byGroup['FRESH_WALLET_LARGE_POSITION [in-play]']?.signal.h1.hitRate).toBe(1);
    expect(byGroup['FRESH_WALLET_LARGE_POSITION [in-play]']?.baseline.h1.hitRate).toBe(0);
    expect(byGroup['FRESH_WALLET_LARGE_POSITION [pre-game]']?.signal.h1.hitRate).toBe(0);
    expect(report.bySignal[0]?.signal.total).toBe(2);
  });
});
