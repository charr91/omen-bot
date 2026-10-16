import type { AppConfig } from '../config/schema.js';
import type { FillRecord } from '../types/fill.js';
import { SignalId, type TriggeredSignal } from '../types/signal.js';
import type { WalletProfile } from '../types/wallet.js';
import { effectivePosition } from './effective-position.js';

interface FreshWalletLongshotContext {
  fill: FillRecord;
  wallet: WalletProfile;
  config: Pick<AppConfig, 'detection'>;
}

/**
 * M2 backtest recommendation: a brand-new wallet (< maxAgeHours, <= maxTransactions) staking >= minStakeUsd on a
 * longshot (effective price < maxPrice), at ANY market size (no niche or market-relative size gate, unlike
 * FRESH_WALLET_LARGE_POSITION). Scored to reach MEDIUM on its own. When `deliver` is false it runs in shadow mode:
 * recorded and outcome-graded, never sent to Telegram/Discord or delivered through the feed.
 */
export function evaluateFreshWalletLongshot(context: FreshWalletLongshotContext): TriggeredSignal | null {
  const cfg = context.config.detection.freshWalletLongshot;
  if (!cfg || !cfg.enabled || !context.wallet.activityAgeKnown) {
    return null;
  }
  const ageHours = context.wallet.ageSeconds / 3600;
  if (ageHours >= cfg.maxAgeHours || context.wallet.totalTransactions > cfg.maxTransactions) {
    return null;
  }
  const position = effectivePosition(context.fill);
  if (!position || position.price >= cfg.maxPrice || position.stakeUsd < cfg.minStakeUsd) {
    return null;
  }
  return {
    signalId: SignalId.FRESH_WALLET_LONGSHOT,
    availability: 'LIVE',
    score: cfg.score,
    confidence: 0.85,
    ...(cfg.deliver ? {} : { shadow: true }),
    evidence: [
      { field: 'wallet_age_hours', value: Number(ageHours.toFixed(2)), threshold: `< ${cfg.maxAgeHours}`, description: 'Wallet is brand new.' },
      { field: 'wallet_total_transactions', value: context.wallet.totalTransactions, threshold: `<= ${cfg.maxTransactions}`, description: 'Wallet has almost no history.' },
      { field: 'effective_price', value: Number(position.price.toFixed(4)), threshold: `< ${cfg.maxPrice}`, description: 'The effective position is a longshot.' },
      { field: 'effective_stake_usd', value: Number(position.stakeUsd.toFixed(2)), threshold: `>= ${cfg.minStakeUsd}`, description: 'Large stake for a first bet, at any market size.' },
      { field: 'effective_outcome', value: position.outcome, threshold: 'n/a', description: 'Side the wallet is effectively backing.' },
    ],
    triggeredAt: new Date(),
  };
}

/** True when a signal must not be delivered (shadow mode): it is still stored, promoted and outcome-graded. */
export function isShadowSignal(signal: Pick<TriggeredSignal, 'shadow'>): boolean {
  return signal.shadow === true;
}

/** Signals that count toward delivery (shadow signals excluded). */
export function deliverableSignals<T extends Pick<TriggeredSignal, 'shadow'>>(signals: T[]): T[] {
  return signals.filter((s) => !isShadowSignal(s));
}
