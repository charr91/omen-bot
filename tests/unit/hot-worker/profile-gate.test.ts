import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fileConfigSchema } from '../../../src/config/schema.js';
import {
  effectiveMinProfileFillUsd,
  lowestSignalMinFillUsd,
  shouldProfileFill,
} from '../../../src/hot-worker/profile-gate.js';

const { parse } = createRequire(import.meta.url)('toml') as { parse(input: string): unknown };

function makeConfig(minProfileFillUsd = 200) {
  return {
    detection: {
      cluster: { minFillUsd: 200 },
      convictionSizeMismatch: { minFillUsd: 250 },
      lumpEntry: { minFillUsd: 500 },
      nicheMarketEntry: { minFillUsd: 1_000 },
      market: { largePositionMinUsd: 1_000 },
    },
    alchemy: { minProfileFillUsd },
  } as unknown as Parameters<typeof effectiveMinProfileFillUsd>[0];
}

describe('profile gate', () => {
  it('finds the lowest live-signal min fill (cluster $200 by default)', () => {
    expect(lowestSignalMinFillUsd(makeConfig())).toBe(200);
  });

  it('caps the configured min at the lowest signal min so no signal-eligible fill is skipped', () => {
    expect(effectiveMinProfileFillUsd(makeConfig(1_000))).toBe(200);
    expect(effectiveMinProfileFillUsd(makeConfig(50))).toBe(50);
  });

  it('skips fills below the min and profiles fills at or above it', () => {
    expect(shouldProfileFill('199.99', 200)).toBe(false);
    expect(shouldProfileFill('200', 200)).toBe(true);
    expect(shouldProfileFill(5_000, 200)).toBe(true);
    expect(shouldProfileFill('not-a-number', 200)).toBe(true);
  });

  it('defaults to $200 min and a 12h cache TTL, matching omen.config.toml', async () => {
    const defaults = fileConfigSchema.parse({});
    expect(defaults.alchemy.min_profile_fill_usd).toBe(200);
    expect(defaults.alchemy.profile_cache_ttl_ms).toBe(12 * 60 * 60_000);
    expect(defaults.detection.cluster.min_fill_usd).toBe(200);

    const file = fileConfigSchema.parse(parse(await readFile('omen.config.toml', 'utf8')));
    expect(file.alchemy.min_profile_fill_usd).toBe(200);
    expect(file.alchemy.profile_cache_ttl_ms).toBe(43_200_000);
  });
});
