import { z } from 'zod';
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
    markets: markets.flatMap((market) => {
      const conditionId = getString(market, ['conditionId', 'condition_id']);
      if (!conditionId) {
        return [];
      }

      return [
        {
          conditionId,
          marketSlug: getString(market, ['slug', 'market_slug']),
          question: getString(market, ['question', 'title']) ?? 'Unknown market',
          dailyVolumeUsd: formatNumericString(
            getNumber(market, ['volume24hrClob', 'volume24hr']) ?? 0,
          ),
          volumeUsd: formatNumericString(getNumber(market, ['volumeNum', 'volume']) ?? 0),
          liquidityUsd: formatNumericString(getNumber(market, ['liquidityNum', 'liquidity']) ?? 0),
        },
      ];
    }),
  };
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
  const response = await fetch(url, init);

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

    const payload = await fetchJson(url);
    const page = jsonArraySchema.parse(payload).map((entry) => asJsonObject(entry, 'gamma market'));

    if (page.length === 0) {
      break;
    }

    markets.push(...page);

    if (page.length < ACTIVE_MARKETS_PAGE_SIZE) {
      break;
    }

    offset += ACTIVE_MARKETS_PAGE_SIZE;
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

function formatNumericString(value: number): string {
  return value.toFixed(6);
}
