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

/** In-play = filled at or after the game's start (sports); non-game = no start time; unknown = not checked yet. */
export type GamePhase = 'pre-game' | 'in-play' | 'non-game' | 'unknown';

export function gamePhase(gameChecked: boolean, gameStartAt: Date | null, alertAt: Date): GamePhase {
  if (!gameChecked) return 'unknown';
  if (gameStartAt === null) return 'non-game';
  return alertAt.getTime() >= gameStartAt.getTime() ? 'in-play' : 'pre-game';
}

export interface OutcomeRow {
  group: string;
  kind: 'signal' | 'baseline';
  side: TradeSide;
  priceAtAlert: number;
  price1h: number | null;
  price24h: number | null;
  resolutionPrice: number | null;
  phase?: GamePhase;
}

export interface HorizonStats {
  /** Priced rows whose price moved (unchanged prices are counted in `flat` and left out of the hit rate). */
  n: number;
  flat: number;
  hits: number;
  hitRate: number | null;
  avgReturn: number | null;
}

export interface HorizonSet {
  h1: HorizonStats;
  h24: HorizonStats;
  resolution: HorizonStats;
}

export interface GroupStats {
  group: string;
  signal: { total: number } & HorizonSet;
  baseline: { total: number } & HorizonSet;
  /**
   * Baseline matched on effective entry-price band: per band, all baseline fills' hit rate / avg return, weighted
   * by this group's priced signal fills in that band (bands with no baseline are left out). n/hits = baseline fills used.
   */
  bandBaseline?: HorizonSet;
}

/** Effective entry price of the position: BUY pays the price, SELL is a position on the other side at 1 - price. */
export function effectiveEntryPrice(side: TradeSide, priceAtAlert: number): number {
  return side === 'BUY' ? priceAtAlert : 1 - priceAtAlert;
}

/** 20-cent effective entry-price bands: 0-20¢, 20-40¢, 40-60¢, 60-80¢, 80-100¢. */
export function entryPriceBand(side: TradeSide, priceAtAlert: number): string {
  const index = Math.min(4, Math.max(0, Math.floor(effectiveEntryPrice(side, priceAtAlert) * 5)));
  return `${index * 20}-${(index + 1) * 20}¢`;
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

function bandMatchedHorizon(
  signals: OutcomeRow[],
  baselinesByBand: Map<string, OutcomeRow[]>,
  pick: (row: OutcomeRow) => number | null,
): HorizonStats {
  const signalsByBand = new Map<string, OutcomeRow[]>();
  for (const row of signals) {
    const band = entryPriceBand(row.side, row.priceAtAlert);
    signalsByBand.set(band, [...(signalsByBand.get(band) ?? []), row]);
  }
  let weight = 0;
  let hitRate = 0;
  let avgReturn = 0;
  const used: HorizonStats = { n: 0, flat: 0, hits: 0, hitRate: null, avgReturn: null };
  for (const [band, bandSignals] of signalsByBand) {
    const signalN = horizon(bandSignals, pick).n;
    const base = horizon(baselinesByBand.get(band) ?? [], pick);
    if (signalN === 0 || base.hitRate === null || base.avgReturn === null) continue;
    weight += signalN;
    hitRate += signalN * base.hitRate;
    avgReturn += signalN * base.avgReturn;
    used.n += base.n;
    used.flat += base.flat;
    used.hits += base.hits;
  }
  return weight === 0 ? used : { ...used, hitRate: hitRate / weight, avgReturn: avgReturn / weight };
}

export function bandMatchedBaseline(signals: OutcomeRow[], baselinePool: OutcomeRow[]): HorizonSet {
  const byBand = new Map<string, OutcomeRow[]>();
  for (const row of baselinePool) {
    const band = entryPriceBand(row.side, row.priceAtAlert);
    byBand.set(band, [...(byBand.get(band) ?? []), row]);
  }
  return {
    h1: bandMatchedHorizon(signals, byBand, (r) => r.price1h),
    h24: bandMatchedHorizon(signals, byBand, (r) => r.price24h),
    resolution: bandMatchedHorizon(signals, byBand, (r) => r.resolutionPrice),
  };
}

/**
 * Rows must already carry their group (signal id or tier); baseline rows are matched to the same group. With a
 * baseline pool (each baseline fill once), every group also gets an entry-price-band matched baseline.
 */
export function aggregateOutcomes(rows: OutcomeRow[], bandBaselinePool?: OutcomeRow[]): GroupStats[] {
  const groups = [...new Set(rows.map((r) => r.group))].sort();
  return groups.map((group) => {
    const inGroup = rows.filter((r) => r.group === group);
    const signals = inGroup.filter((r) => r.kind === 'signal');
    return {
      group,
      signal: summarize(signals),
      baseline: summarize(inGroup.filter((r) => r.kind === 'baseline')),
      ...(bandBaselinePool ? { bandBaseline: bandMatchedBaseline(signals, bandBaselinePool) } : {}),
    };
  });
}
