import { describe, expect, it } from 'vitest';
import { buildVolumeBaseline, detectVolumeSpike } from '../../../src/signals/volume-baseline.js';

const hour = (iso: string) => new Date(iso);

describe('time-of-day volume baseline (insider-poly-bot port)', () => {
  const samples = [
    { timestamp: hour('2026-10-10T14:10:00Z'), volumeUsd: 100 },
    { timestamp: hour('2026-10-11T14:20:00Z'), volumeUsd: 120 },
    { timestamp: hour('2026-10-10T03:00:00Z'), volumeUsd: 10 },
  ];
  const baseline = buildVolumeBaseline(samples, hour('2026-10-10T00:00:00Z'), hour('2026-10-12T00:00:00Z'));

  it('fills empty hours with zero and groups by UTC hour of day', () => {
    expect(baseline.hours).toBe(48);
    expect(baseline.hourly[14]).toMatchObject({ avg: 110, samples: 2 });
    expect(baseline.hourly[5]).toMatchObject({ avg: 0, samples: 2 });
    expect(baseline.avgHourlyVolume).toBeCloseTo(230 / 48);
  });

  it('compares against the same hour of day when it has enough samples', () => {
    const normal = detectVolumeSpike(120, baseline, hour('2026-10-12T14:30:00Z'));
    expect(normal.baselineType).toBe('time_aware');
    expect(normal.isSpike).toBe(false);
    const spike = detectVolumeSpike(400, baseline, hour('2026-10-12T14:30:00Z'));
    expect(spike.isSpike).toBe(true);
    expect(spike.multiplier).toBeCloseTo(400 / 110);
  });

  it('falls back to the overall baseline for quiet hours, and reports none without history', () => {
    const quiet = detectVolumeSpike(50, baseline, hour('2026-10-12T05:00:00Z'));
    expect(quiet.baselineType).toBe('overall');
    expect(quiet.isSpike).toBe(true);
    const empty = buildVolumeBaseline([], hour('2026-10-10T00:00:00Z'), hour('2026-10-10T05:00:00Z'));
    expect(detectVolumeSpike(10, empty, hour('2026-10-10T06:00:00Z'))).toMatchObject({ isSpike: false, baselineType: 'none' });
  });
});
