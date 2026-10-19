import { describe, expect, it } from 'vitest';
import { aggregateOutcomes, directionalReturn, entryPriceBand, isHit, type OutcomeRow } from '../../../src/outcomes/scoring.js';
import { buildStatsReport, formatCents, formatStatsTable, groupOutcomeRows } from '../../../src/outcomes/stats.js';
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

  it('shows average move in cents and an entry-price-band matched baseline', () => {
    const base: OutcomeQueryRow = {
      group: '', kind: 'signal', side: 'BUY', signalIds: ['FRESH_WALLET_LONGSHOT'], deliveryTier: 'MEDIUM',
      priceAtAlert: 0.1, price1h: 0.13, price24h: null, resolutionPrice: null,
    };
    const rows: OutcomeQueryRow[] = [
      base,
      { ...base, priceAtAlert: 0.15, price1h: 0.14 },
      // SELL at 0.9 = an effective 10¢ position on the other side: same 0-20¢ band
      { ...base, side: 'SELL', priceAtAlert: 0.9, price1h: 0.85 },
      { ...base, kind: 'baseline', signalIds: ['OTHER'], priceAtAlert: 0.05, price1h: 0.04 },
      { ...base, kind: 'baseline', signalIds: ['OTHER'], priceAtAlert: 0.1, price1h: 0.12 },
      { ...base, kind: 'baseline', signalIds: ['OTHER'], priceAtAlert: 0.7, price1h: 0.9 },
    ];
    const report = buildStatsReport(rows);
    const longshot = report.bySignal.find((g) => g.group === 'FRESH_WALLET_LONGSHOT')!;
    expect(longshot.signal.h1.hitRate).toBeCloseTo(2 / 3);
    expect(longshot.signal.h1.avgReturn).toBeCloseTo((0.03 - 0.01 + 0.05) / 3);
    // Only the 0-20¢ baselines (one hit of two) match the signal's band; the 70¢ baseline is excluded.
    expect(longshot.bandBaseline?.h1).toMatchObject({ n: 2, hits: 1, hitRate: 0.5 });
    expect(longshot.bandBaseline?.h1.avgReturn).toBeCloseTo(0.005);
    expect(longshot.bandBaseline?.h24.hitRate).toBeNull();
    expect(report.bySignalPriceBand.map((g) => g.group)).toEqual(['FRESH_WALLET_LONGSHOT [0-20¢]', 'OTHER [0-20¢]', 'OTHER [60-80¢]']);

    const table = formatStatsTable('By signal', report.bySignal);
    expect(table).toContain('+2.3¢');
    expect(table).toContain('band-base');
    expect(table).toMatch(/band-edge\s+\+16\.7pp \+1\.8¢/);
  });

  it('bands effective entry prices in 20-cent steps', () => {
    expect(entryPriceBand('BUY', 0)).toBe('0-20¢');
    expect(entryPriceBand('BUY', 0.2)).toBe('20-40¢');
    expect(entryPriceBand('BUY', 1)).toBe('80-100¢');
    expect(entryPriceBand('SELL', 0.95)).toBe('0-20¢');
    expect(formatCents(-0.0125)).toBe('  -1.3¢');
    expect(formatCents(null).trim()).toBe('-');
  });
});
