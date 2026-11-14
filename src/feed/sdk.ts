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

/**
 * Prefer the real `@charr91/smart-money-feed` package when it is installed
 * (production / optionalDependency). Fall back to the local no-op shim so
 * outsiders can install and test without access to that private repo.
 */
export async function loadFeedRuntime(): Promise<FeedRuntime> {
  try {
    const spec = '@charr91/smart-money-feed';
    const mod = (await import(spec)) as Partial<FeedRuntime>;
    if (typeof mod.FeedClient === 'function' && typeof mod.XBridge === 'function') {
      return {
        FeedClient: mod.FeedClient,
        XBridge: mod.XBridge,
        loadXOptions: mod.loadXOptions ?? shimLoadXOptions,
        parseEnvelope: mod.parseEnvelope ?? shimParseEnvelope,
      };
    }
  } catch {
    // Package missing or failed to load; use the shim.
  }
  return {
    FeedClient: ShimFeedClient,
    XBridge: ShimXBridge,
    loadXOptions: shimLoadXOptions,
    parseEnvelope: shimParseEnvelope,
  };
}
