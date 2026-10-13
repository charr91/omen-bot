import type { FillOutcome, FillSide, NewFill } from '../types/fill.js';

/**
 * The trader's effective position. On a binary market, selling YES at p is economically buying NO at 1 - p (and
 * vice versa), so price-based logic ("longshot", conviction stake) must use the effective outcome and price, not
 * the raw fill price: a SELL of YES at 0.24 is a NO position at 0.76, a favourite, not a longshot.
 */
export interface EffectivePosition {
  outcome: FillOutcome;
  price: number;
  /** USD actually at risk on the effective side: shares x effective price. */
  stakeUsd: number;
}

export function effectivePosition(fill: Pick<NewFill, 'side' | 'outcome' | 'price' | 'shares' | 'sizeUsd'>): EffectivePosition | null {
  const price = Number(fill.price);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  const shares = Number(fill.shares);
  const notional = Number(fill.sizeUsd);
  const units = Number.isFinite(shares) && shares > 0 ? shares : Number.isFinite(notional) ? notional / price : NaN;
  if (!Number.isFinite(units)) return null;
  if (fill.side === 'BUY') return { outcome: fill.outcome, price, stakeUsd: units * price };
  const outcome: FillOutcome = fill.outcome === 'YES' ? 'NO' : 'YES';
  return { outcome, price: 1 - price, stakeUsd: units * (1 - price) };
}

export function effectiveSideLabel(side: FillSide, outcome: FillOutcome): string {
  return side === 'BUY' ? outcome : outcome === 'YES' ? 'NO' : 'YES';
}
