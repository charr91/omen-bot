/**
 * Time-of-day volume baseline, ported from insider-poly-bot detection/volume_detector.py
 * (calculate_baseline_metrics, _get_time_aware_baseline, detect_volume_spike).
 *
 * Hourly volume buckets are grouped by UTC hour-of-day; the current hour is compared with the mean/std for the same
 * hour, falling back to the overall hourly mean/std. A spike is multiplier >= spikeMultiplier, z >= zThreshold, or
 * volume above the overall p95. Deviation from the Python: the p95 check needs >= 24 active hours, because on sparse
 * markets (mostly empty hours) p95 is ~0 and would flag almost every trade.
 */
export interface VolumeSample {
  timestamp: Date;
  volumeUsd: number;
}

export interface VolumeBaseline {
  avgHourlyVolume: number;
  stdHourlyVolume: number;
  hourly: Record<number, { avg: number; std: number; samples: number }>;
  p95: number | null;
  hours: number;
  activeHours: number;
}

export interface VolumeSpikeResult {
  isSpike: boolean;
  multiplier: number;
  zScore: number;
  baselineType: 'time_aware' | 'overall' | 'none';
  avgVolume: number;
}

export const DEFAULT_VOLUME_SPIKE_THRESHOLDS = { spikeMultiplier: 3, zThreshold: 3, minHourSamples: 2 };

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

/** Buckets samples into whole UTC hours between `from` and `to` (empty hours count as 0 volume). */
export function buildVolumeBaseline(samples: VolumeSample[], from: Date, to: Date): VolumeBaseline {
  const startHour = Math.floor(from.getTime() / 3_600_000);
  const endHour = Math.floor(to.getTime() / 3_600_000);
  const buckets = new Map<number, number>();
  for (let h = startHour; h < endHour; h += 1) buckets.set(h, 0);
  for (const sample of samples) {
    const h = Math.floor(sample.timestamp.getTime() / 3_600_000);
    if (buckets.has(h)) buckets.set(h, buckets.get(h)! + sample.volumeUsd);
  }

  const volumes = [...buckets.values()];
  const byHourOfDay = new Map<number, number[]>();
  for (const [h, volume] of buckets) {
    const hourOfDay = ((h % 24) + 24) % 24;
    byHourOfDay.set(hourOfDay, [...(byHourOfDay.get(hourOfDay) ?? []), volume]);
  }

  const hourly: VolumeBaseline['hourly'] = {};
  for (const [hourOfDay, values] of byHourOfDay) {
    hourly[hourOfDay] = { avg: mean(values), std: std(values), samples: values.length };
  }

  return {
    avgHourlyVolume: mean(volumes),
    stdHourlyVolume: std(volumes),
    hourly,
    p95: percentile([...volumes].sort((a, b) => a - b), 0.95),
    hours: volumes.length,
    activeHours: volumes.filter((v) => v > 0).length,
  };
}

export function detectVolumeSpike(
  currentHourVolumeUsd: number,
  baseline: VolumeBaseline,
  at: Date,
  thresholds = DEFAULT_VOLUME_SPIKE_THRESHOLDS,
): VolumeSpikeResult {
  const hourData = baseline.hourly[at.getUTCHours()];
  let avg = baseline.avgHourlyVolume;
  let sd = baseline.stdHourlyVolume;
  let baselineType: VolumeSpikeResult['baselineType'] = 'overall';
  if (hourData && hourData.samples >= thresholds.minHourSamples && hourData.avg > 0) {
    avg = hourData.avg;
    sd = hourData.std || baseline.stdHourlyVolume;
    baselineType = 'time_aware';
  }

  if (!(avg > 0)) {
    return { isSpike: false, multiplier: 0, zScore: 0, baselineType: 'none', avgVolume: 0 };
  }

  const multiplier = currentHourVolumeUsd / avg;
  const zScore = sd > 0 ? (currentHourVolumeUsd - avg) / sd : 0;
  const isSpike =
    multiplier >= thresholds.spikeMultiplier ||
    zScore >= thresholds.zThreshold ||
    (baseline.activeHours >= 24 && baseline.p95 !== null && baseline.p95 > 0 && currentHourVolumeUsd > baseline.p95);
  return { isSpike, multiplier, zScore, baselineType, avgVolume: avg };
}
