import { aggregateOutcomes, type GroupStats, type HorizonStats } from './scoring.js';
import type { OutcomeQueryRow } from './store.js';

export type StatsGrouping = 'signal' | 'tier';

/** Expands rows into one row per signal id (or per tier); baseline rows inherit their reference signal's groups. */
export function groupOutcomeRows(rows: OutcomeQueryRow[], by: StatsGrouping) {
  return rows.flatMap((row) => {
    const groups = by === 'signal' ? row.signalIds : [row.deliveryTier ?? 'NO_ALERT'];
    return groups.map((group) => ({ ...row, group }));
  });
}

function pct(value: number | null): string {
  return value === null ? '   -  ' : `${(value * 100).toFixed(1).padStart(5)}%`;
}

function cell(stats: HorizonStats): string {
  return `${pct(stats.hitRate)} n=${String(stats.n).padEnd(4)}`;
}

function edge(signal: HorizonStats, baseline: HorizonStats): string {
  if (signal.hitRate === null || baseline.hitRate === null) return '   -  ';
  const diff = (signal.hitRate - baseline.hitRate) * 100;
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp`.padStart(7);
}

export function formatStatsTable(title: string, stats: GroupStats[]): string {
  const header = `${'group'.padEnd(28)} ${'kind'.padEnd(8)} ${'total'.padStart(5)}  ${'hit@1h'.padEnd(14)} ${'hit@24h'.padEnd(14)} ${'hit@resolution'.padEnd(14)}`;
  const lines = [title, header, '-'.repeat(header.length)];
  for (const group of stats) {
    for (const kind of ['signal', 'baseline'] as const) {
      const s = group[kind];
      lines.push(
        `${(kind === 'signal' ? group.group : '').padEnd(28)} ${kind.padEnd(8)} ${String(s.total).padStart(5)}  ${cell(s.h1)} ${cell(s.h24)} ${cell(s.resolution)}`,
      );
    }
    lines.push(
      `${''.padEnd(28)} ${'edge'.padEnd(8)} ${''.padStart(5)}  ${edge(group.signal.h1, group.baseline.h1).padEnd(14)} ${edge(group.signal.h24, group.baseline.h24).padEnd(14)} ${edge(group.signal.resolution, group.baseline.resolution).padEnd(14)}`,
    );
  }
  return lines.join('\n');
}

export function buildStatsReport(rows: OutcomeQueryRow[]): { bySignal: GroupStats[]; byTier: GroupStats[] } {
  return {
    bySignal: aggregateOutcomes(groupOutcomeRows(rows, 'signal')),
    byTier: aggregateOutcomes(groupOutcomeRows(rows, 'tier')),
  };
}
