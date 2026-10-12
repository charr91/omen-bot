/** Direction-adjusted outcome scoring for a single traded token. */
export type TradeSide = 'BUY' | 'SELL';

/** Signed price move in the direction of the trade (BUY profits when the token price rises). */
export function directionalReturn(side: TradeSide, priceAtAlert: number, laterPrice: number): number {
  return side === 'BUY' ? laterPrice - priceAtAlert : priceAtAlert - laterPrice;
}

/** A hit is a strictly favourable move; unchanged prices count as misses. */
export function isHit(side: TradeSide, priceAtAlert: number, laterPrice: number | null): boolean | null {
  if (laterPrice === null || !Number.isFinite(laterPrice) || !Number.isFinite(priceAtAlert)) return null;
  return directionalReturn(side, priceAtAlert, laterPrice) > 0;
}

export interface OutcomeRow {
  group: string;
  kind: 'signal' | 'baseline';
  side: TradeSide;
  priceAtAlert: number;
  price1h: number | null;
  price24h: number | null;
  resolutionPrice: number | null;
}

export interface HorizonStats {
  /** Priced rows whose price moved (unchanged prices are counted in `flat` and left out of the hit rate). */
  n: number;
  flat: number;
  hits: number;
  hitRate: number | null;
  avgReturn: number | null;
}

export interface GroupStats {
  group: string;
  signal: { total: number; h1: HorizonStats; h24: HorizonStats; resolution: HorizonStats };
  baseline: { total: number; h1: HorizonStats; h24: HorizonStats; resolution: HorizonStats };
}

function horizon(rows: OutcomeRow[], pick: (row: OutcomeRow) => number | null): HorizonStats {
  let n = 0;
  let flat = 0;
  let hits = 0;
  let sum = 0;
  for (const row of rows) {
    const later = pick(row);
    const hit = isHit(row.side, row.priceAtAlert, later);
    if (hit === null || later === null) continue;
    if (directionalReturn(row.side, row.priceAtAlert, later) === 0) {
      flat += 1;
      continue;
    }
    n += 1;
    if (hit) hits += 1;
    sum += directionalReturn(row.side, row.priceAtAlert, later);
  }
  return { n, flat, hits, hitRate: n === 0 ? null : hits / n, avgReturn: n === 0 ? null : sum / n };
}

function summarize(rows: OutcomeRow[]) {
  return {
    total: rows.length,
    h1: horizon(rows, (r) => r.price1h),
    h24: horizon(rows, (r) => r.price24h),
    resolution: horizon(rows, (r) => r.resolutionPrice),
  };
}

/** Rows must already carry their group (signal id or tier); baseline rows are matched to the same group. */
export function aggregateOutcomes(rows: OutcomeRow[]): GroupStats[] {
  const groups = [...new Set(rows.map((r) => r.group))].sort();
  return groups.map((group) => {
    const inGroup = rows.filter((r) => r.group === group);
    return {
      group,
      signal: summarize(inGroup.filter((r) => r.kind === 'signal')),
      baseline: summarize(inGroup.filter((r) => r.kind === 'baseline')),
    };
  });
}
