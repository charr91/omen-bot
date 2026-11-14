export {
  parseEnvelope,
  loadXOptions,
  FeedClient as ShimFeedClient,
  XBridge as ShimXBridge,
  type AlertEnvelope,
  type AlertEnvelopeInput,
  type Severity,
  type XAnnotation,
  type XBridgeOptions,
  type XRequestInput,
  type EnqueueResult,
  type FeedClient as FeedClientInstance,
  type XBridge as XBridgeInstance,
} from './shim.js';

import {
  FeedClient as ShimFeedClient,
  XBridge as ShimXBridge,
  loadXOptions as shimLoadXOptions,
  parseEnvelope as shimParseEnvelope,
} from './shim.js';

export type FeedRuntime = {
  FeedClient: typeof ShimFeedClient;
  XBridge: typeof ShimXBridge;
  loadXOptions: typeof shimLoadXOptions;
  parseEnvelope: typeof shimParseEnvelope;
};

export const FEED_PACKAGE_SPEC = '@charr91/smart-money-feed';

export type LoadFeedRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  specifier?: string;
};

/**
 * The local no-op shim is opt-in only. Enable it with OMEN_FEED_SHIM=1
 * (or true/yes). OMEN_FEED_SHIM=0 disables it even under NODE_ENV=test.
 * When the flag is unset, NODE_ENV=test allows the shim so `pnpm test`
 * works without the private feed package.
 */
export function feedShimAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OMEN_FEED_SHIM?.trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  return env.NODE_ENV === 'test';
}

export function missingFeedPackageError(cause?: unknown): Error {
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  const suffix = detail ? ` Underlying error: ${detail}` : '';
  return new Error(
    `Failed to load ${FEED_PACKAGE_SPEC}. This package is required at runtime unless the local no-op shim is explicitly enabled. ` +
      `Install the package, or set OMEN_FEED_SHIM=1 (or run with NODE_ENV=test) to use the local shim. ` +
      `The shim is for tests and limited local runs without the private feed package; it must not be used in production.` +
      suffix,
  );
}

/**
 * Prefer the real `@charr91/smart-money-feed` package when it is installed
 * (production / optionalDependency). Fall back to the local no-op shim only
 * when that is explicitly allowed (see feedShimAllowed).
 */
export async function loadFeedRuntime(options: LoadFeedRuntimeOptions = {}): Promise<FeedRuntime> {
  const env = options.env ?? process.env;
  const specifier = options.specifier ?? FEED_PACKAGE_SPEC;
  let loadError: unknown;
  try {
    const mod = (await import(specifier)) as Partial<FeedRuntime>;
    if (typeof mod.FeedClient === 'function' && typeof mod.XBridge === 'function') {
      return {
        FeedClient: mod.FeedClient,
        XBridge: mod.XBridge,
        loadXOptions: mod.loadXOptions ?? shimLoadXOptions,
        parseEnvelope: mod.parseEnvelope ?? shimParseEnvelope,
      };
    }
    loadError = new Error(`${specifier} loaded but did not export FeedClient and XBridge`);
  } catch (err) {
    loadError = err;
  }
  if (feedShimAllowed(env)) {
    return {
      FeedClient: ShimFeedClient,
      XBridge: ShimXBridge,
      loadXOptions: shimLoadXOptions,
      parseEnvelope: shimParseEnvelope,
    };
  }
  throw missingFeedPackageError(loadError);
}
