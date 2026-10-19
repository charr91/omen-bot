import { aggregateOutcomes, entryPriceBand, type GroupStats, type HorizonStats } from './scoring.js';
import type { OutcomeQueryRow } from './store.js';

export type StatsGrouping = 'signal' | 'tier' | 'signal-phase' | 'signal-band';

/** Expands rows into one row per signal id (or per tier); baseline rows inherit their reference signal's groups. */
export function groupOutcomeRows(rows: OutcomeQueryRow[], by: StatsGrouping) {
  return rows.flatMap((row) => {
    const groups =
      by === 'tier'
        ? [row.deliveryTier ?? 'NO_ALERT']
        : by === 'signal-phase'
          ? row.signalIds.map((id) => `${id} [${row.phase ?? 'unknown'}]`)
          : by === 'signal-band'
            ? row.signalIds.map((id) => `${id} [${entryPriceBand(row.side, row.priceAtAlert)}]`)
            : row.signalIds;
    return groups.map((group) => ({ ...row, group }));
  });
}

function pct(value: number | null): string {
  return value === null ? '   -  ' : `${(value * 100).toFixed(1).padStart(5)}%`;
}

/** Average directional move in cents (avgReturn is a price fraction: 0.013 = +1.3¢). */
export function formatCents(avgReturn: number | null): string {
  if (avgReturn === null) return '    -  ';
  const cents = avgReturn * 100;
  return `${cents >= 0 ? '+' : ''}${cents.toFixed(1)}¢`.padStart(7);
}

const CELL_WIDTH = 23;

function cell(stats: HorizonStats): string {
  return `${pct(stats.hitRate)} ${formatCents(stats.avgReturn)} n=${String(stats.n).padEnd(5)}`;
}

function edge(signal: HorizonStats, baseline: HorizonStats): string {
  if (signal.hitRate === null || baseline.hitRate === null) return '   -  ';
  const diff = (signal.hitRate - baseline.hitRate) * 100;
  const move = signal.avgReturn === null || baseline.avgReturn === null ? '' : ` ${formatCents(signal.avgReturn - baseline.avgReturn).trim()}`;
  return `${`${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp`.padStart(7)}${move}`;
}

export function formatStatsTable(title: string, stats: GroupStats[]): string {
  const columns = ['hit / avg move @1h', 'hit / avg move @24h', 'hit / avg move @res'].map((c) => c.padEnd(CELL_WIDTH));
  const header = `${'group'.padEnd(32)} ${'kind'.padEnd(9)} ${'total'.padStart(5)}  ${columns.join(' ')}`.trimEnd();
  const lines = [title, header, '-'.repeat(header.length)];
  const row = (group: string, kind: string, total: string, cells: string[]) =>
    `${group.padEnd(32)} ${kind.padEnd(9)} ${total.padStart(5)}  ${cells.map((c) => c.padEnd(CELL_WIDTH)).join(' ')}`.trimEnd();
  for (const group of stats) {
    for (const kind of ['signal', 'baseline'] as const) {
      const s = group[kind];
      lines.push(row(kind === 'signal' ? group.group : '', kind, String(s.total), [cell(s.h1), cell(s.h24), cell(s.resolution)]));
    }
    lines.push(
      row('', 'edge', '', [
        edge(group.signal.h1, group.baseline.h1),
        edge(group.signal.h24, group.baseline.h24),
        edge(group.signal.resolution, group.baseline.resolution),
      ]),
    );
    const band = group.bandBaseline;
    if (band) {
      lines.push(row('', 'band-base', '', [cell(band.h1), cell(band.h24), cell(band.resolution)]));
      lines.push(
        row('', 'band-edge', '', [
          edge(group.signal.h1, band.h1),
          edge(group.signal.h24, band.h24),
          edge(group.signal.resolution, band.resolution),
        ]),
      );
    }
  }
  return lines.join('\n');
}

export function buildStatsReport(rows: OutcomeQueryRow[]): {
  bySignal: GroupStats[];
  byTier: GroupStats[];
  bySignalPhase: GroupStats[];
  bySignalPriceBand: GroupStats[];
} {
  const baselinePool = rows.filter((row) => row.kind === 'baseline');
  return {
    bySignal: aggregateOutcomes(groupOutcomeRows(rows, 'signal'), baselinePool),
    bySignalPhase: aggregateOutcomes(groupOutcomeRows(rows, 'signal-phase')),
    byTier: aggregateOutcomes(groupOutcomeRows(rows, 'tier'), baselinePool),
    bySignalPriceBand: aggregateOutcomes(groupOutcomeRows(rows, 'signal-band'), baselinePool),
  };
}
