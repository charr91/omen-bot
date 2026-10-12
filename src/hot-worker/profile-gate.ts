import type { AppConfig } from '../config/schema.js';
import type { WalletChainProfile } from '../types/wallet.js';

/**
 * Lowest fill size (USD) at which any live signal can fire. Below it the fill cannot change alerting,
 * so chain profiling and funding-graph rebuilds (the Alchemy-heavy work) are skipped.
 */
export function lowestSignalMinFillUsd(config: Pick<AppConfig, 'detection'>): number {
  const detection = config.detection;
  return Math.min(
    detection.cluster.minFillUsd,
    detection.convictionSizeMismatch.minFillUsd,
    detection.lumpEntry.minFillUsd,
    detection.nicheMarketEntry.minFillUsd,
    // fresh-wallet and outsized-position use max(large_position_min_usd, % of daily volume)
    detection.market.largePositionMinUsd,
  );
}

/** Lowest fill size at which a signal that needs the on-chain profile (fresh-wallet age/txns) can fire. */
export function chainProfileSignalMinFillUsd(config: Pick<AppConfig, 'detection'>): number {
  return config.detection.market.largePositionMinUsd;
}

/**
 * Alchemy profiling threshold: the configured min, capped at the fresh-wallet minimum so a fill that could
 * fire fresh-wallet is always profiled. Fills between lowestSignalMinFillUsd and this value are still
 * evaluated (cluster / conviction / lump use DB data) but with the persisted or conservative chain profile.
 */
export function effectiveMinProfileFillUsd(config: Pick<AppConfig, 'detection' | 'alchemy'>): number {
  return Math.min(config.alchemy.minProfileFillUsd, chainProfileSignalMinFillUsd(config));
}

export type ProfileMode = 'skip' | 'light' | 'full';

export function profileModeForFill(sizeUsd: string | number, config: Pick<AppConfig, 'detection' | 'alchemy'>): ProfileMode {
  const value = Number(sizeUsd);
  if (!Number.isFinite(value)) return 'full';
  if (value < lowestSignalMinFillUsd(config)) return 'skip';
  return value >= effectiveMinProfileFillUsd(config) ? 'full' : 'light';
}

/**
 * A persisted profile is reusable only when the wallet is "settled": its known age is already past the elevated
 * fresh window, or it is already past max_txns. Both only grow, so later activity can never make it look fresh.
 * Fresh-looking (or unknown-age) wallets are always re-fetched. Checked for both the wallet and freshness fields.
 */
export function isSettledChainProfile(profile: WalletChainProfile, config: Pick<AppConfig, 'detection'>): boolean {
  const fresh = config.detection.freshWallet;
  const settled = (known: boolean, ageSeconds: number, txns: number): boolean =>
    (known && ageSeconds >= fresh.elevatedAgeHours * 3600) || txns > fresh.maxTransactions;
  return (
    settled(profile.activityAgeKnown, profile.ageSeconds, profile.totalTransactions) &&
    settled(profile.freshnessActivityAgeKnown, profile.freshnessAgeSeconds, profile.freshnessTotalTransactions)
  );
}
