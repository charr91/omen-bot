import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEED_PACKAGE_SPEC,
  feedShimAllowed,
  loadFeedRuntime,
  missingFeedPackageError,
  ShimFeedClient,
  ShimXBridge,
} from '../../../src/feed/sdk.js';

describe('feedShimAllowed', () => {
  it('is enabled by OMEN_FEED_SHIM=1/true/yes even outside test', () => {
    expect(feedShimAllowed({ OMEN_FEED_SHIM: '1' })).toBe(true);
    expect(feedShimAllowed({ OMEN_FEED_SHIM: 'true', NODE_ENV: 'production' })).toBe(true);
    expect(feedShimAllowed({ OMEN_FEED_SHIM: 'YES' })).toBe(true);
  });

  it('is disabled by OMEN_FEED_SHIM=0 even when NODE_ENV=test', () => {
    expect(feedShimAllowed({ OMEN_FEED_SHIM: '0', NODE_ENV: 'test' })).toBe(false);
    expect(feedShimAllowed({ OMEN_FEED_SHIM: 'false', NODE_ENV: 'test' })).toBe(false);
  });

  it('defaults to allowed only under NODE_ENV=test when the flag is unset', () => {
    expect(feedShimAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(feedShimAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(feedShimAllowed({})).toBe(false);
  });
});

describe('loadFeedRuntime', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('fails fast when the package is missing and the shim is not allowed', async () => {
    const missing = `${FEED_PACKAGE_SPEC}-missing-for-test`;
    await expect(
      loadFeedRuntime({ env: { NODE_ENV: 'production' }, specifier: missing }),
    ).rejects.toThrow(/OMEN_FEED_SHIM=1/);
    await expect(
      loadFeedRuntime({ env: { NODE_ENV: 'production' }, specifier: missing }),
    ).rejects.toThrow(missingFeedPackageError().message.split(' Underlying error:')[0]!);
  });

  it('uses the local shim when the package is missing and the shim is allowed', async () => {
    const runtime = await loadFeedRuntime({
      env: { OMEN_FEED_SHIM: '1', NODE_ENV: 'production' },
      specifier: `${FEED_PACKAGE_SPEC}-missing-for-test`,
    });
    expect(runtime.FeedClient).toBe(ShimFeedClient);
    expect(runtime.XBridge).toBe(ShimXBridge);
  });
});
