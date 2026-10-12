import { describe, expect, it } from 'vitest';
import { aggregateOutcomes, directionalReturn, isHit, type OutcomeRow } from '../../../src/outcomes/scoring.js';
import { buildStatsReport, formatStatsTable, groupOutcomeRows } from '../../../src/outcomes/stats.js';
import type { OutcomeQueryRow } from '../../../src/outcomes/store.js';

describe('outcome scoring', () => {
  it('scores BUY up and SELL down as hits', () => {
    expect(directionalReturn('BUY', 0.4, 0.5)).toBeCloseTo(0.1);
    expect(directionalReturn('SELL', 0.4, 0.5)).toBeCloseTo(-0.1);
    expect(isHit('BUY', 0.4, 1)).toBe(true);
    expect(isHit('SELL', 0.4, 0)).toBe(true);
    expect(isHit('BUY', 0.4, null)).toBeNull();
  });

  it('aggregates signal vs baseline per group and leaves flat prices out of the hit rate', () => {
    const base = { group: 'X', price24h: null, resolutionPrice: null } as const;
    const rows: OutcomeRow[] = [
      { ...base, kind: 'signal', side: 'BUY', priceAtAlert: 0.3, price1h: 0.4 },
      { ...base, kind: 'signal', side: 'BUY', priceAtAlert: 0.3, price1h: 0.2 },
      { ...base, kind: 'signal', side: 'SELL', priceAtAlert: 0.3, price1h: 0.3 },
      { ...base, kind: 'baseline', side: 'BUY', priceAtAlert: 0.5, price1h: 0.4 },
    ];
    const [stats] = aggregateOutcomes(rows);
    expect(stats!.signal.total).toBe(3);
    expect(stats!.signal.h1).toMatchObject({ n: 2, flat: 1, hits: 1, hitRate: 0.5 });
    expect(stats!.baseline.h1).toMatchObject({ n: 1, hits: 0, hitRate: 0 });
    expect(stats!.signal.h24.hitRate).toBeNull();
  });

  it('expands rows per signal id and per tier, and formats an edge column', () => {
    const row: OutcomeQueryRow = {
      group: '',
      kind: 'signal',
      side: 'BUY',
      signalIds: ['LUMP_ENTRY', 'OUTSIZED_POSITION'],
      deliveryTier: null,
      priceAtAlert: 0.2,
      price1h: 0.3,
      price24h: 0.1,
      resolutionPrice: 1,
    };
    expect(groupOutcomeRows([row], 'signal').map((r) => r.group)).toEqual(['LUMP_ENTRY', 'OUTSIZED_POSITION']);
    expect(groupOutcomeRows([row], 'tier').map((r) => r.group)).toEqual(['NO_ALERT']);
    const report = buildStatsReport([row, { ...row, kind: 'baseline', price1h: 0.1 }]);
    const table = formatStatsTable('By signal', report.bySignal);
    expect(table).toContain('LUMP_ENTRY');
    expect(table).toContain('+100.0pp');
  });
});
