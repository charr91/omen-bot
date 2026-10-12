import type { AppConfig } from '../config/schema.js';

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

/** Effective profiling threshold: the configured min, capped so it never hides a fill a signal could use. */
export function effectiveMinProfileFillUsd(config: Pick<AppConfig, 'detection' | 'alchemy'>): number {
  return Math.min(config.alchemy.minProfileFillUsd, lowestSignalMinFillUsd(config));
}

export function shouldProfileFill(sizeUsd: string | number, minProfileFillUsd: number): boolean {
  const value = Number(sizeUsd);
  // Unparseable sizes are profiled (fail open toward detection, not toward savings).
  return !Number.isFinite(value) || value >= minProfileFillUsd;
}
