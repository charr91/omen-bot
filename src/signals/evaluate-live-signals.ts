import type { AppConfig } from '../config/schema.js';
import { clampSuspicionScore } from './scoring.js';
import { evaluateFreshWalletLargePosition } from './fresh-wallet-large-position.js';
import { evaluateOutsizedPosition } from './outsized-position.js';
import type { FillRecord } from '../types/fill.js';
import type { MarketInfo } from '../types/market.js';
import type { TriggeredSignal } from '../types/signal.js';
import type { WalletProfile } from '../types/wallet.js';

interface EvaluateLiveSignalsContext {
  fill: FillRecord;
  wallet: WalletProfile;
  market: MarketInfo | null;
  config: Pick<AppConfig, 'detection'>;
}

export function evaluateLiveSignals(context: EvaluateLiveSignalsContext): TriggeredSignal[] {
  if (context.wallet.isWhitelisted || context.market === null) {
    return [];
  }

  const signals: TriggeredSignal[] = [];

  const outsizedPosition = evaluateOutsizedPosition({
    fill: context.fill,
    market: context.market,
    config: context.config,
  });
  if (outsizedPosition) {
    signals.push(outsizedPosition);
  }

  if (!context.wallet.isContract) {
    const freshWalletLargePosition = evaluateFreshWalletLargePosition({
      fill: context.fill,
      wallet: context.wallet,
      market: context.market,
      config: context.config,
    });
    if (freshWalletLargePosition) {
      signals.push(freshWalletLargePosition);
    }
  }

  return signals;
}

export function computeCompositeLiveScore(signals: TriggeredSignal[]): number {
  return clampSuspicionScore(signals.reduce((total, signal) => total + signal.score, 0));
}
