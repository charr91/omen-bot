import { z } from 'zod';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import {
  ACTIVE_MARKETS_PAGE_SIZE,
  BOOK_REQUEST_BATCH_SIZE,
  POLYMARKET_CLOB_URL,
  POLYMARKET_DATA_API_URL,
  POLYMARKET_GAMMA_URL,
  PUBLIC_TRADE_POLL_LIMIT,
} from './constants.js';
import {
  asJsonObject,
  getNumber,
  getJsonArray,
  getString,
  parseStringArray,
} from './json.js';
import type { ActiveAsset, ActiveMarket, JsonObject } from './types.js';

const jsonArraySchema = z.array(z.unknown());
const GAMMA_MARKETS_SERVER_PAGE_CAP = 100;
const polymarketRestCircuitBreaker = new CircuitBreaker('polymarket rest');

export async function fetchActiveAssets(): Promise<{
  assets: ActiveAsset[];
  marketCount: number;
}> {
  const markets = await fetchAllActiveMarkets();
  const assets = new Map<string, ActiveAsset>();
  let marketCount = 0;

  for (const market of markets) {
    const conditionId = getString(market, ['conditionId', 'condition_id']);
    if (!conditionId) {
      continue;
    }

    marketCount += 1;

    const question = getString(market, ['question', 'title']) ?? 'Unknown market';
    const marketSlug = getString(market, ['slug', 'market_slug']);
    const tokenIds = extractTokenIds(market);
    const outcomes = extractOutcomes(market);

    for (const [index, assetId] of tokenIds.entries()) {
      if (assets.has(assetId)) {
        continue;
      }

      assets.set(assetId, {
        assetId,
        conditionId,
        marketSlug,
        question,
        outcome: outcomes[index] ?? null,
      });
    }
  }

  return {
    assets: [...assets.values()],
    marketCount,
  };
}

export async function fetchActiveMarkets(): Promise<{
  markets: ActiveMarket[];
}> {
  const markets = await fetchAllActiveMarkets();

  return {
    markets: markets.flatMap(mapGammaMarket),
  };
}

// box-dry-run: shared mapper + on-demand lookup by condition id (Gamma caps offset paging at ~2100).
function mapGammaMarket(market: JsonObject): ActiveMarket[] {
  const conditionId = getString(market, ['conditionId', 'condition_id']);
  if (!conditionId) {
    return [];
  }

  return [
    {
      conditionId,
      eventSlug: extractEventSlug(market),
      marketSlug: getString(market, ['slug', 'market_slug']),
      question: getString(market, ['question', 'title']) ?? 'Unknown market',
      // Larger of the two: either can lag the other.
      dailyVolumeUsd: formatNumericString(
        Math.max(getNumber(market, ['volume24hrClob']) ?? 0, getNumber(market, ['volume24hr']) ?? 0),
      ),
      gameStartTime: extractGameStartTime(market),
      category: extractCategory(market),
      tags: extractTags(market),
      sportsMarketType: getString(market, ['sportsMarketType']),
      volumeUsd: formatNumericString(getNumber(market, ['volumeNum', 'volume']) ?? 0),
      liquidityUsd: formatNumericString(getNumber(market, ['liquidityNum', 'liquidity']) ?? 0),
    },
  ];
}

function firstEvent(market: JsonObject): JsonObject | null {
  const events = Array.isArray(market.events) ? (market.events as unknown[]) : [];
  return events[0] && typeof events[0] === 'object' ? (events[0] as JsonObject) : null;
}

/** Gamma's legacy `category` (market, else event); most current markets only carry tags. */
export function extractCategory(market: JsonObject): string | null {
  const event = firstEvent(market);
  return getString(market, ['category']) ?? (event ? getString(event, ['category']) : null);
}

/** Tag slugs and labels from the market (include_tag=true) and its first event, lowercased and deduplicated. */
export function extractTags(market: JsonObject): string[] {
  const event = firstEvent(market);
  const out = new Set<string>();
  for (const source of [market, event]) {
    const tags = source && Array.isArray(source.tags) ? (source.tags as unknown[]) : [];
    for (const tag of tags) {
      if (typeof tag === 'string') out.add(tag.toLowerCase());
      else if (tag && typeof tag === 'object') {
        for (const key of ['slug', 'label']) {
          const value = (tag as JsonObject)[key];
          if (typeof value === 'string' && value.length > 0) out.add(value.toLowerCase());
        }
      }
    }
  }
  const seriesSlug = event ? getString(event, ['seriesSlug']) : null;
  if (seriesSlug) out.add(`series:${seriesSlug.toLowerCase()}`);
  return [...out];
}

/** Sports: Gamma's market `gameStartTime` ("2026-10-13 00:00:00+00"), else the event's `startTime`. */
export function extractGameStartTime(market: JsonObject): string | null {
  const raw = getString(market, ['gameStartTime']);
  const events = Array.isArray(market.events) ? (market.events as unknown[]) : [];
  const event = events[0] && typeof events[0] === 'object' ? (events[0] as JsonObject) : null;
  const fallback = event ? getString(event, ['startTime']) : null;
  for (const candidate of [raw, fallback]) {
    if (!candidate) continue;
    const iso = candidate.replace(' ', 'T').replace(/\+00$/, 'Z');
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/** `closed: true` is needed for settled markets: Gamma's condition_ids lookup returns [] for them otherwise. */
export async function fetchMarketsByConditionIds(conditionIds: string[], options: { closed?: boolean } = {}): Promise<ActiveMarket[]> {
  if (conditionIds.length === 0) {
    return [];
  }
  const url = new URL('/markets', POLYMARKET_GAMMA_URL);
  for (const conditionId of conditionIds) {
    url.searchParams.append('condition_ids', conditionId);
  }
  url.searchParams.set('limit', String(conditionIds.length));
  url.searchParams.set('include_tag', 'true');
  if (options.closed) url.searchParams.set('closed', 'true');
  const payload = await fetchJson(url);
  return jsonArraySchema
    .parse(payload)
    .map((entry) => asJsonObject(entry, 'gamma market'))
    .flatMap(mapGammaMarket);
}

export async function fetchPublicTrades(offset = 0): Promise<JsonObject[]> {
  const url = new URL('/trades', POLYMARKET_DATA_API_URL);
  url.searchParams.set('limit', String(PUBLIC_TRADE_POLL_LIMIT));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('takerOnly', 'true');

  const payload = await fetchJson(url);
  return jsonArraySchema.parse(payload).map((entry) => asJsonObject(entry, 'public trade'));
}

export async function fetchOrderBooks(assetIds: string[]): Promise<JsonObject[]> {
  const books: JsonObject[] = [];

  for (let index = 0; index < assetIds.length; index += BOOK_REQUEST_BATCH_SIZE) {
    const chunk = assetIds.slice(index, index + BOOK_REQUEST_BATCH_SIZE);
    const payload = await fetchJson(new URL('/books', POLYMARKET_CLOB_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(chunk.map((assetId) => ({ token_id: assetId }))),
    });

    books.push(
      ...jsonArraySchema.parse(payload).map((entry) => asJsonObject(entry, 'order book snapshot')),
    );
  }

  return books;
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
  const response = await polymarketRestCircuitBreaker.execute(async () =>
    fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }),
  );

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function fetchAllActiveMarkets(): Promise<JsonObject[]> {
  const markets: JsonObject[] = [];
  let offset = 0;

  while (true) {
    const url = new URL('/markets', POLYMARKET_GAMMA_URL);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', String(ACTIVE_MARKETS_PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('include_tag', 'true');

    let payload: unknown;
    try {
      payload = await fetchJson(url);
    } catch (error) {
      // box-dry-run: Gamma returns 422 past its offset cap (~2100); treat as end of listing.
      if (offset > 0 && error instanceof Error && error.message.includes('422')) {
        break;
      }
      throw error;
    }
    const page = jsonArraySchema.parse(payload).map((entry) => asJsonObject(entry, 'gamma market'));

    if (page.length === 0) {
      break;
    }

    markets.push(...page);

    // box-dry-run: Gamma now caps /markets at 100 rows regardless of `limit`, so a short page no
    // longer means the end; the old check stopped after the first 100 markets and almost every
    // fill resolved to market=null (no signals). Page by the returned length until a short/empty page
    // below the server cap.
    if (page.length < Math.min(ACTIVE_MARKETS_PAGE_SIZE, GAMMA_MARKETS_SERVER_PAGE_CAP)) {
      break;
    }

    offset += page.length;
  }

  return markets;
}

function extractTokenIds(market: JsonObject): string[] {
  const tokens = getJsonArray(market, ['tokens']);
  if (tokens) {
    const fromTokens = tokens
      .map((entry) => asJsonObject(entry, 'gamma token'))
      .map((token) => getString(token, ['token_id', 'tokenId']))
      .filter((tokenId): tokenId is string => tokenId !== null);

    if (fromTokens.length > 0) {
      return fromTokens;
    }
  }

  return parseStringArray(getJsonArray(market, ['clobTokenIds']) ?? getString(market, ['clobTokenIds']));
}

function extractOutcomes(market: JsonObject): string[] {
  const tokens = getJsonArray(market, ['tokens']);
  if (tokens) {
    const fromTokens = tokens
      .map((entry) => asJsonObject(entry, 'gamma token'))
      .map((token) => getString(token, ['outcome', 'name']))
      .filter((outcome): outcome is string => outcome !== null);

    if (fromTokens.length > 0) {
      return fromTokens;
    }
  }

  return parseStringArray(getJsonArray(market, ['outcomes']) ?? getString(market, ['outcomes']));
}

function extractEventSlug(market: JsonObject): string | null {
  const directSlug = getString(market, ['eventSlug', 'event_slug']);
  if (directSlug) {
    return directSlug;
  }

  const events = getJsonArray(market, ['events']);
  if (!events) {
    return null;
  }

  for (const entry of events) {
    const event = asJsonObject(entry, 'gamma event');
    const slug = getString(event, ['slug', 'eventSlug', 'event_slug']);
    if (slug) {
      return slug;
    }
  }

  return null;
}

function formatNumericString(value: number): string {
  return value.toFixed(6);
}
