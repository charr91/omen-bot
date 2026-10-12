import { POLYMARKET_CLOB_URL, POLYMARKET_GAMMA_URL } from '../phase0/constants.js';

export interface PricePoint {
  t: number; // unix seconds
  p: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function getJson(url: URL, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url.pathname}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Picks the history point closest to `targetSec`, if one lies within `maxDistanceSec`. */
export function pickClosestPrice(points: PricePoint[], targetSec: number, maxDistanceSec: number): number | null {
  let best: PricePoint | null = null;
  for (const point of points) {
    if (!Number.isFinite(point.p) || !Number.isFinite(point.t)) continue;
    if (best === null || Math.abs(point.t - targetSec) < Math.abs(best.t - targetSec)) best = point;
  }
  return best !== null && Math.abs(best.t - targetSec) <= maxDistanceSec ? best.p : null;
}

/** Token price near `at` from the CLOB prices-history endpoint (1-minute fidelity, +/- windowSec). */
export async function fetchTokenPriceAt(
  tokenId: string,
  at: Date,
  options: { windowSec?: number; fetchImpl?: typeof fetch } = {},
): Promise<number | null> {
  const windowSec = options.windowSec ?? 15 * 60;
  const target = Math.floor(at.getTime() / 1000);
  const url = new URL('/prices-history', POLYMARKET_CLOB_URL);
  url.searchParams.set('market', tokenId);
  url.searchParams.set('startTs', String(target - windowSec));
  url.searchParams.set('endTs', String(target + windowSec));
  url.searchParams.set('fidelity', '1');
  const payload = (await getJson(url, options.fetchImpl ?? fetch)) as { history?: PricePoint[] };
  return pickClosestPrice(payload.history ?? [], target, windowSec);
}

export interface MarketResolution {
  conditionId: string;
  resolved: boolean;
  closedAt: Date | null;
  /** Final price per CLOB token id (1 = won, 0 = lost); only set when resolved. */
  tokenPrices: Record<string, number>;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseGammaResolution(market: Record<string, unknown>): MarketResolution | null {
  const conditionId = typeof market.conditionId === 'string' ? market.conditionId.toLowerCase() : null;
  if (!conditionId) return null;
  const tokens = parseJsonArray(market.clobTokenIds);
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  const closed = market.closed === true;
  const settled =
    tokens.length > 0 &&
    tokens.length === prices.length &&
    prices.every((p) => p === 0 || p === 1) &&
    prices.filter((p) => p === 1).length === 1;
  const umaStatus = typeof market.umaResolutionStatus === 'string' ? market.umaResolutionStatus : null;
  const resolved = closed && settled && (umaStatus === null || umaStatus === 'resolved');
  const closedAtRaw = typeof market.closedTime === 'string' ? Date.parse(market.closedTime.replace(' ', 'T').replace(/\+00$/, 'Z')) : NaN;
  return {
    conditionId,
    resolved,
    closedAt: Number.isFinite(closedAtRaw) ? new Date(closedAtRaw) : null,
    tokenPrices: resolved ? Object.fromEntries(tokens.map((token, i) => [token, prices[i]!])) : {},
  };
}

/** Looks up open and closed markets by condition id (Gamma hides closed markets unless closed=true). */
export async function fetchMarketResolutions(
  conditionIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<MarketResolution[]> {
  if (conditionIds.length === 0) return [];
  const results: MarketResolution[] = [];
  for (const closed of ['true', 'false']) {
    const url = new URL('/markets', POLYMARKET_GAMMA_URL);
    for (const id of conditionIds) url.searchParams.append('condition_ids', id);
    url.searchParams.set('closed', closed);
    url.searchParams.set('limit', String(conditionIds.length));
    const payload = await getJson(url, fetchImpl);
    for (const entry of Array.isArray(payload) ? payload : []) {
      const parsed = entry && typeof entry === 'object' ? parseGammaResolution(entry as Record<string, unknown>) : null;
      if (parsed) results.push(parsed);
    }
  }
  return results;
}
