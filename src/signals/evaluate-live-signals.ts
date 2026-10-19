import type { AppConfig } from '../config/schema.js';
import { clampSuspicionScore } from './scoring.js';
import { evaluateConvictionSizeMismatch } from './conviction-size-mismatch.js';
import { evaluateFreshWalletLargePosition } from './fresh-wallet-large-position.js';
import { deliverableSignals, evaluateFreshWalletLongshot } from './fresh-wallet-longshot.js';
import { evaluateLumpEntry } from './lump-entry.js';
import { evaluateNicheMarketEntry } from './niche-market-entry.js';
import { evaluateOutsizedPosition } from './outsized-position.js';
import { evaluateSybilCluster, type LiveClusterSignalContext } from './sybil-cluster.js';
import type { FillRecord } from '../types/fill.js';
import type { MarketInfo } from '../types/market.js';
import type { TriggeredSignal } from '../types/signal.js';
import type { WalletProfile } from '../types/wallet.js';
import { classifyMarketExclusion, type MarketExclusionConfig } from './market-exclusion.js';

interface EvaluateLiveSignalsContext {
  fill: FillRecord;
  wallet: WalletProfile;
  market: MarketInfo | null;
  config: Pick<AppConfig, 'detection'> & Partial<Pick<AppConfig, 'filters'>>;
  cluster: LiveClusterSignalContext | null;
}

export function evaluateLiveSignals(context: EvaluateLiveSignalsContext): TriggeredSignal[] {
  const market = context.market;
  if (context.wallet.isWhitelisted || market === null) {
    return [];
  }

  if (classifyMarketExclusion(market, marketExclusionConfig(context.config)) !== null) {
    return [];
  }

  const signals: TriggeredSignal[] = [];

  const outsizedPosition = evaluateOutsizedPosition({
    fill: context.fill,
    market,
    config: context.config,
  });
  if (outsizedPosition) {
    signals.push(outsizedPosition);
  }

  const nicheMarketEntry = evaluateNicheMarketEntry({
    fill: context.fill,
    market,
    config: context.config,
  });
  if (nicheMarketEntry) {
    signals.push(nicheMarketEntry);
  }

  const lumpEntry = evaluateLumpEntry({
    fill: context.fill,
    wallet: context.wallet,
    config: context.config,
  });
  if (lumpEntry) {
    signals.push(lumpEntry);
  }

  const convictionSizeMismatch = evaluateConvictionSizeMismatch({
    fill: context.fill,
    wallet: context.wallet,
    config: context.config,
  });
  if (convictionSizeMismatch) {
    signals.push(convictionSizeMismatch);
  }

  const sybilCluster = evaluateSybilCluster({
    fill: context.fill,
    cluster: context.cluster,
    config: context.config,
  });
  if (sybilCluster) {
    signals.push(sybilCluster);
  }

  // Contract wallets remain eligible here because the hot worker rewrites the wallet
  // profile with resolved controller age/tx data when attribution succeeds.
  const freshWalletLargePosition = evaluateFreshWalletLargePosition({
      fill: context.fill,
      wallet: context.wallet,
      market,
      config: context.config,
    });
  if (freshWalletLargePosition) {
    signals.push(freshWalletLargePosition);
  }

  const freshWalletLongshot = evaluateFreshWalletLongshot({ fill: context.fill, wallet: context.wallet, config: context.config });
  if (freshWalletLongshot) {
    signals.push(freshWalletLongshot);
  }

  return signals;
}

export function computeCompositeLiveScore(signals: TriggeredSignal[]): number {
  return clampSuspicionScore(signals.reduce((total, signal) => total + signal.score, 0));
}

/** Composite score of the signals that may be delivered (shadow-mode signals excluded). */
export function computeDeliverableLiveScore(signals: TriggeredSignal[]): number {
  return computeCompositeLiveScore(deliverableSignals(signals));
}

export function marketExclusionConfig(
  config: Pick<AppConfig, 'detection'> & Partial<Pick<AppConfig, 'filters'>>,
): MarketExclusionConfig {
  return {
    keywordCategories: config.detection.excludedCategories,
    excludeCategories: config.filters?.excludeCategories ?? null,
  };
}
