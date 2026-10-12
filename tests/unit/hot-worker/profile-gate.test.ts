import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fileConfigSchema } from '../../../src/config/schema.js';
import {
  effectiveMinProfileFillUsd,
  lowestSignalMinFillUsd,
  profileModeForFill,
  isSettledChainProfile,
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
      freshWallet: { criticalAgeHours: 24, elevatedAgeHours: 72, maxTransactions: 10 },
    },
    alchemy: { minProfileFillUsd },
  } as unknown as Parameters<typeof effectiveMinProfileFillUsd>[0];
}

describe('profile gate', () => {
  it('finds the lowest live-signal min fill (cluster $200 by default)', () => {
    expect(lowestSignalMinFillUsd(makeConfig())).toBe(200);
  });

  it('caps the configured min at the fresh-wallet min so fresh-wallet always gets a profile', () => {
    expect(effectiveMinProfileFillUsd(makeConfig(5_000))).toBe(1_000);
    expect(effectiveMinProfileFillUsd(makeConfig(500))).toBe(500);
  });

  it('skips below the lowest signal min, light below the Alchemy min, full at or above it', () => {
    const config = makeConfig(500);
    expect(profileModeForFill('199.99', config)).toBe('skip');
    expect(profileModeForFill('200', config)).toBe('light');
    expect(profileModeForFill(499, config)).toBe('light');
    expect(profileModeForFill('500', config)).toBe('full');
    expect(profileModeForFill(1_000, config)).toBe('full');
    expect(profileModeForFill('not-a-number', config)).toBe('full');
  });

  it('only treats never-fresh-again wallets as settled', () => {
    const config = makeConfig();
    const base = {
      ageSeconds: 100 * 3600, activityAgeKnown: true, totalTransactions: 3, isContract: false, controllerAddress: null,
      freshnessAgeSeconds: 100 * 3600, freshnessActivityAgeKnown: true, freshnessTotalTransactions: 3, firstActivityAt: null,
    };
    expect(isSettledChainProfile(base, config)).toBe(true);
    expect(isSettledChainProfile({ ...base, ageSeconds: 3600, freshnessAgeSeconds: 3600 }, config)).toBe(false);
    expect(isSettledChainProfile({ ...base, ageSeconds: 3600, freshnessAgeSeconds: 3600, totalTransactions: 50, freshnessTotalTransactions: 50 }, config)).toBe(true);
    expect(isSettledChainProfile({ ...base, activityAgeKnown: false, freshnessActivityAgeKnown: false }, config)).toBe(false);
  });

  it('defaults to $500 min and a 24h cache TTL, matching omen.config.toml', async () => {
    const defaults = fileConfigSchema.parse({});
    expect(defaults.alchemy.min_profile_fill_usd).toBe(500);
    expect(defaults.alchemy.profile_cache_ttl_ms).toBe(24 * 60 * 60_000);
    expect(defaults.alchemy.persisted_profile_ttl_ms).toBe(7 * 24 * 60 * 60_000);

    const file = fileConfigSchema.parse(parse(await readFile('omen.config.toml', 'utf8')));
    expect(file.alchemy.min_profile_fill_usd).toBe(1_000);
    expect(file.alchemy.profile_cache_ttl_ms).toBe(86_400_000);
  });
});
