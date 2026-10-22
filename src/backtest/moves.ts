import { directionalReturn, entryPriceBand } from '../outcomes/scoring.js';
import type { BacktestCase } from './cases.js';
import type { RawMarket, RawTrade } from './data.js';
import type { GradedFill } from './replay.js';

/**
 * Price moves in the M1 `omen outcomes` frame, rebuilt from the public tape: for each graded fill, the traded token's
 * price at +1h, +24h and resolution, as a directional move (BUY gains when the token rises). Flat moves are left out
 * of n and the averages, as live. Prices come from the last taker trade at or before the horizon (either token; the
 * other token is 1 - price); after the market closed, the resolution price (1 winner / 0 loser) is used.
 */
export type Horizon = 'h1' | 'h24' | 'resolution';
export const HORIZONS: Horizon[] = ['h1', 'h24', 'resolution'];

export interface MoveRow {
  caseId: string;
  kind: BacktestCase['kind'];
  band: string;
  /** Directional move per horizon (price fraction), null when unpriced. */
  moves: Record<Horizon, number | null>;
}

export class TapePricer {
  private readonly ts: number[];
  private readonly yes: number[];

  constructor(
    trades: RawTrade[],
    private readonly closedAt: number | null,
    private readonly winning: 'YES' | 'NO',
  ) {
    const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    this.ts = sorted.map((t) => t.timestamp);
    // YES-token price implied by each trade.
    this.yes = sorted.map((t) => (outcomeOf(t.outcome, t.outcomeIndex) === 'YES' ? t.price : 1 - t.price));
  }

  /** YES-token price at `t`, or null before the first trade. */
  yesAt(t: number): number | null {
    if (this.closedAt !== null && t >= this.closedAt) return this.winning === 'YES' ? 1 : 0;
    let lo = 0;
    let hi = this.ts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? null : this.yes[found]!;
  }

  tokenAt(token: 'YES' | 'NO', t: number): number | null {
    const y = this.yesAt(t);
    return y === null ? null : token === 'YES' ? y : 1 - y;
  }

  resolution(token: 'YES' | 'NO'): number {
    return token === this.winning ? 1 : 0;
  }
}

export function outcomeOf(outcome: string | undefined, index?: number): 'YES' | 'NO' {
  if (outcome) return outcome.trim().toLowerCase() === 'no' ? 'NO' : 'YES';
  return index === 1 ? 'NO' : 'YES';
}

export function moveRow(testCase: BacktestCase, fill: GradedFill, pricer: TapePricer): MoveRow {
  const at = (t: number) => pricer.tokenAt(fill.tokenOutcome, t);
  const mv = (later: number | null) => (later === null ? null : directionalReturn(fill.side, fill.price, later));
  return {
    caseId: testCase.id,
    kind: testCase.kind,
    band: entryPriceBand(fill.side, fill.price),
    moves: {
      h1: mv(at(fill.timestamp + 3_600)),
      h24: mv(at(fill.timestamp + 86_400)),
      resolution: mv(pricer.resolution(fill.tokenOutcome)),
    },
  };
}

export interface MoveStat {
  n: number;
  hitRate: number | null;
  avg: number | null;
}

export function moveStat(rows: MoveRow[], h: Horizon): MoveStat {
  let n = 0;
  let hits = 0;
  let sum = 0;
  for (const r of rows) {
    const m = r.moves[h];
    if (m === null || m === 0) continue;
    n += 1;
    sum += m;
    if (m > 0) hits += 1;
  }
  return { n, hitRate: n ? hits / n : null, avg: n ? sum / n : null };
}

/**
 * Baseline matched on market AND effective entry-price band: for every (case, band) cell holding signal fills, the
 * baseline fills of that same market and band, weighted by the cell's priced signal fills (cells without baseline
 * are dropped from both sides). Returns the signal stats over the matched cells and the weighted baseline.
 */
export function bandMatched(signal: MoveRow[], baseline: MoveRow[], h: Horizon): { signal: MoveStat; base: MoveStat; edge: number | null } {
  const cells = new Map<string, MoveRow[]>();
  for (const r of baseline) {
    const k = `${r.caseId}|${r.band}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  const sigCells = new Map<string, MoveRow[]>();
  for (const r of signal) {
    const k = `${r.caseId}|${r.band}`;
    sigCells.set(k, [...(sigCells.get(k) ?? []), r]);
  }
  const matched: MoveRow[] = [];
  let w = 0;
  let baseAvg = 0;
  let baseHit = 0;
  let baseN = 0;
  for (const [k, rows] of sigCells) {
    const s = moveStat(rows, h);
    const b = moveStat(cells.get(k) ?? [], h);
    if (s.n === 0 || b.avg === null || b.hitRate === null) continue;
    matched.push(...rows);
    w += s.n;
    baseAvg += s.n * b.avg;
    baseHit += s.n * b.hitRate;
    baseN += b.n;
  }
  const sig = moveStat(matched, h);
  const base: MoveStat = { n: baseN, hitRate: w ? baseHit / w : null, avg: w ? baseAvg / w : null };
  return { signal: sig, base, edge: sig.avg !== null && base.avg !== null ? sig.avg - base.avg : null };
}

/** Per-case pricer from the replay tape (window) plus the post-news tape (news .. news + 25 h). */
export function pricerFor(testCase: BacktestCase, market: RawMarket, trades: RawTrade[]): TapePricer {
  return new TapePricer(trades, market.closedAt ?? null, testCase.winningOutcome);
}
