import { resolve } from 'node:path';
import { z } from 'zod';
import { createAuthenticatedTradeReader } from './auth.js';
import {
  ANALYSIS_DIRECTORY_NAME,
  AUTH_TRADE_POLL_INTERVAL_MS,
  AUTH_TRADES_FILE_NAME,
  CAPTURE_RETRY_ATTEMPTS,
  CAPTURE_RETRY_BASE_MS,
  FINDINGS_FILE_NAME,
  MANIFEST_FILE_NAME,
  MAX_PUBLIC_TRADE_KEY_WINDOW,
  OBSERVED_ASSETS_FILE_NAME,
  ORDER_BOOKS_FILE_NAME,
  PHASE0_VERSION,
  PUBLIC_TRADE_MAX_OFFSET,
  PUBLIC_TRADE_POLL_INTERVAL_MS,
  PUBLIC_TRADES_FILE_NAME,
  RAW_DIRECTORY_NAME,
  SUMMARY_FILE_NAME,
  PUBLIC_TRADE_POLL_LIMIT,
  WS_MESSAGES_FILE_NAME,
} from './constants.js';
import { createJsonlWriter, ensureDirectory, sleep, writeJsonFile, writeTextFile } from './io.js';
import { captureManifestSchema } from './manifest.js';
import { fetchActiveAssets, fetchOrderBooks, fetchPublicTrades } from './public-api.js';
import { getJsonArray, getNumber, getString } from './json.js';
import { startMarketWsCapture, type WsCaptureController } from './ws.js';
import type { ActiveAsset, CaptureManifest, JsonLineEnvelope, JsonObject } from './types.js';

interface CaptureOptions {
  hours: number;
  out: string;
  useAuth: boolean;
}

interface NewPublicTrade {
  key: string;
  trade: JsonObject;
}

export async function runPhase0Capture(options: CaptureOptions): Promise<{
  runDirectory: string;
}> {
  const runDirectory = resolve(options.out);
  const rawDirectory = resolve(runDirectory, RAW_DIRECTORY_NAME);
  const analysisDirectory = resolve(runDirectory, ANALYSIS_DIRECTORY_NAME);

  await ensureDirectory(rawDirectory);
  await ensureDirectory(analysisDirectory);

  const discovery = await fetchActiveAssets();
  const assetsById = new Map(discovery.assets.map((asset) => [asset.assetId, asset] as const));
  const observedAssets = new Map<string, ActiveAsset>();

  const manifest: CaptureManifest = {
    version: PHASE0_VERSION,
    startedAt: new Date().toISOString(),
    completedAt: null,
    runDirectory,
    requestedHours: options.hours,
    useAuth: options.useAuth,
    sources: {
      gammaMarkets: 'https://gamma-api.polymarket.com/markets?active=true&closed=false',
      publicTrades: 'https://data-api.polymarket.com/trades?limit=500&offset=0&takerOnly=true',
      orderBooks: 'https://clob.polymarket.com/books',
      marketWebSocket: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
      authenticatedTrades: options.useAuth,
    },
    discovery: {
      activeAssets: discovery.assets.length,
      activeMarkets: discovery.marketCount,
    },
    counts: {
      publicTradeObservations: 0,
      orderBookSnapshots: 0,
      wsMessages: 0,
      authTradeObservations: 0,
    },
  };

  await persistManifest(runDirectory, manifest);

  const publicTradeWriter = createJsonlWriter<JsonLineEnvelope>(resolve(rawDirectory, PUBLIC_TRADES_FILE_NAME));
  const orderBookWriter = createJsonlWriter<JsonLineEnvelope>(resolve(rawDirectory, ORDER_BOOKS_FILE_NAME));
  const wsWriter = createJsonlWriter<JsonLineEnvelope>(resolve(rawDirectory, WS_MESSAGES_FILE_NAME));
  const authWriter = createJsonlWriter<JsonLineEnvelope>(resolve(rawDirectory, AUTH_TRADES_FILE_NAME));

  let wsController: WsCaptureController = {
    subscribe: async () => undefined,
    stop: async () => undefined,
  };
  try {
    wsController = await startMarketWsCapture({
      onMessage: async (payload) => {
        const compactBook = compactBookPayload(payload, 'ws-book');
        if (!compactBook) {
          return;
        }

        manifest.counts.wsMessages += 1;
        await wsWriter.write({
          source: 'market-ws',
          capturedAt: new Date().toISOString(),
          payload: compactBook,
        });
      },
    });
  } catch {
    wsController = {
      subscribe: async () => undefined,
      stop: async () => undefined,
    };
  }

  const readAuthenticatedTrades = await createAuthenticatedTradeReader(options.useAuth);
  const seenPublicTradeKeys = new Set<string>();
  const seenPublicTradeKeyOrder: string[] = [];
  const seenAuthTradeIds = new Set<string>();
  const endTimeMs = Date.now() + options.hours * 60 * 60 * 1000;
  let lastAuthPollAt = 0;
  let pollId = 0;

  try {
    while (Date.now() < endTimeMs) {
      pollId += 1;
      const capturedAt = new Date().toISOString();
      const publicTrades = await runWithRetries(
        'fetch public trades',
        () => fetchVisiblePublicTrades(seenPublicTradeKeys),
      ).catch(async (error: unknown) => {
        warnCaptureStep(error, 'public trades');
        await persistManifest(runDirectory, manifest);
        return null;
      });
      if (!publicTrades) {
        const remainingMs = endTimeMs - Date.now();
        if (remainingMs > 0) {
          await sleep(Math.min(PUBLIC_TRADE_POLL_INTERVAL_MS, remainingMs));
        }
        continue;
      }
      const assetIds = new Set<string>();

      for (const { key, trade } of publicTrades) {
        const asset = typeof trade.asset === 'string' ? trade.asset : null;
        if (asset) {
          assetIds.add(asset);
          const metadata = assetsById.get(asset);
          if (metadata) {
            observedAssets.set(asset, metadata);
          }
        }

        manifest.counts.publicTradeObservations += 1;
        await publicTradeWriter.write({
          source: 'data-api-trade',
          capturedAt,
          pollId,
          payload: trade,
        });
        addBoundedKey(seenPublicTradeKeys, seenPublicTradeKeyOrder, key, MAX_PUBLIC_TRADE_KEY_WINDOW);
      }

      if (assetIds.size > 0) {
        try {
          await wsController.subscribe([...assetIds]);
        } catch (error) {
          warnCaptureStep(error, 'websocket subscribe');
        }

        const orderBooks = await runWithRetries(
          'fetch order books',
          () => fetchOrderBooks([...assetIds]),
        ).catch((error: unknown) => {
          warnCaptureStep(error, 'order books');
          return null;
        });
        if (orderBooks) {
          for (const orderBook of orderBooks) {
            const compactBook = compactBookPayload(orderBook, 'rest-book');
            if (!compactBook) {
              continue;
            }

            manifest.counts.orderBookSnapshots += 1;
            await orderBookWriter.write({
              source: 'clob-book',
              capturedAt,
              pollId,
              payload: compactBook,
            });
          }
        }
      }

      if (readAuthenticatedTrades && Date.now() - lastAuthPollAt >= AUTH_TRADE_POLL_INTERVAL_MS) {
        const authTrades = await runWithRetries('fetch authenticated trades', () =>
          readAuthenticatedTrades(),
        ).catch((error: unknown) => {
          warnCaptureStep(error, 'authenticated trades');
          return null;
        });
        if (authTrades) {
          for (const trade of authTrades) {
            const tradeId = typeof trade.id === 'string' ? trade.id : null;
            if (!tradeId || seenAuthTradeIds.has(tradeId)) {
              continue;
            }

            seenAuthTradeIds.add(tradeId);
            manifest.counts.authTradeObservations += 1;
            await authWriter.write({
              source: 'auth-trade',
              capturedAt,
              pollId,
              payload: trade,
            });
          }
        }

        lastAuthPollAt = Date.now();
      }

      await persistManifest(runDirectory, manifest);
      const remainingMs = endTimeMs - Date.now();
      if (remainingMs > 0) {
        await sleep(Math.min(PUBLIC_TRADE_POLL_INTERVAL_MS, remainingMs));
      }
    }
  } finally {
    manifest.completedAt = new Date().toISOString();
    await wsController.stop();
    await publicTradeWriter.close();
    await orderBookWriter.close();
    await wsWriter.close();
    await authWriter.close();
    await persistManifest(runDirectory, manifest);
    await writeJsonFile(resolve(runDirectory, OBSERVED_ASSETS_FILE_NAME), {
      assets: [...observedAssets.values()],
    });
    await writeJsonFile(resolve(analysisDirectory, SUMMARY_FILE_NAME), { status: 'pending-analysis' });
    await writeTextFile(
      resolve(analysisDirectory, FINDINGS_FILE_NAME),
      'Run `omen validate-fills analyze --input <runDir>` after capture completes.',
    );
  }

  return {
    runDirectory,
  };
}

export async function fetchVisiblePublicTrades(
  knownTradeKeys: ReadonlySet<string>,
  fetchPage: (offset: number) => Promise<JsonObject[]> = fetchPublicTrades,
  pageSize = PUBLIC_TRADE_POLL_LIMIT,
  maxOffset = PUBLIC_TRADE_MAX_OFFSET,
): Promise<NewPublicTrade[]> {
  const trades: NewPublicTrade[] = [];
  const pollSeenKeys = new Set<string>();

  for (let offset = 0; offset <= maxOffset; offset += pageSize) {
    let page: JsonObject[];
    try {
      page = await fetchPage(offset);
    } catch (error) {
      if (offset > 0 && error instanceof Error && error.message.includes('400 Bad Request')) {
        break;
      }
      throw error;
    }
    const newTradesInPage = selectNewPublicTrades(page, knownTradeKeys, pollSeenKeys);
    trades.push(...newTradesInPage);

    if (offset === maxOffset && page.length === pageSize && newTradesInPage.length > 0) {
      throw new Error(
        `Public trade window exceeded max paginable offset ${maxOffset}; refusing to continue with possible silent trade loss.`,
      );
    }

    if (page.length < pageSize || newTradesInPage.length === 0) {
      break;
    }
  }

  return trades;
}

async function persistManifest(runDirectory: string, manifest: CaptureManifest): Promise<void> {
  await writeJsonFile(
    resolve(runDirectory, MANIFEST_FILE_NAME),
    captureManifestSchema.parse(manifest) as unknown as Record<string, unknown>,
  );
}

export function stableTradeObservationKey(trade: JsonObject): string {
  const proxyWallet = typeof trade.proxyWallet === 'string' ? trade.proxyWallet : 'null';
  const transactionHash = typeof trade.transactionHash === 'string' ? trade.transactionHash : 'null';
  const asset = typeof trade.asset === 'string' ? trade.asset : 'null';
  const conditionId = typeof trade.conditionId === 'string' ? trade.conditionId : 'null';
  const side = typeof trade.side === 'string' ? trade.side : 'UNKNOWN';
  const price =
    typeof trade.price === 'number' || typeof trade.price === 'string' ? String(trade.price) : 'null';
  const size =
    typeof trade.size === 'number' || typeof trade.size === 'string' ? String(trade.size) : 'null';
  const timestamp =
    typeof trade.timestamp === 'number' || typeof trade.timestamp === 'string'
      ? String(trade.timestamp)
      : 'null';

  return [proxyWallet, transactionHash, asset, conditionId, side, price, size, timestamp].join('|');
}

export function selectNewPublicTrades(
  trades: JsonObject[],
  knownTradeKeys: ReadonlySet<string>,
  pollSeenKeys: Set<string>,
): NewPublicTrade[] {
  const newTrades: NewPublicTrade[] = [];

  for (const trade of trades) {
    const key = stableTradeObservationKey(trade);
    if (knownTradeKeys.has(key) || pollSeenKeys.has(key)) {
      continue;
    }

    pollSeenKeys.add(key);
    newTrades.push({ key, trade });
  }

  return newTrades;
}

function compactBookPayload(
  payload: JsonObject,
  source: 'rest-book' | 'ws-book',
): JsonObject | null {
  const assetId = getString(payload, ['asset_id', 'asset']);
  const timestamp = getString(payload, ['timestamp']) ?? getNumber(payload, ['timestamp']);

  if (!assetId || timestamp === null) {
    return null;
  }

  const bestBid = extractBestLevelPrice(payload, 'bids', 'best_bid');
  const bestAsk = extractBestLevelPrice(payload, 'asks', 'best_ask');

  const compactPayload: JsonObject = {
    asset_id: assetId,
    market: getString(payload, ['market']),
    timestamp,
    best_bid: bestBid,
    best_ask: bestAsk,
    tick_size: getNumber(payload, ['tick_size', 'tickSize']),
    source,
  };

  if (source === 'ws-book') {
    compactPayload.event_type = 'book';
  }

  return compactPayload;
}

function extractBestLevelPrice(
  payload: JsonObject,
  levelsKey: 'bids' | 'asks',
  compactKey: 'best_bid' | 'best_ask',
): number | null {
  const compactPrice = getNumber(payload, [compactKey]);
  if (compactPrice !== null) {
    return compactPrice;
  }

  const levels = getJsonArray(payload, [levelsKey]);
  if (!levels || levels.length === 0) {
    return null;
  }

  const firstLevel = levels[0];
  if (typeof firstLevel !== 'object' || firstLevel === null || Array.isArray(firstLevel)) {
    return null;
  }

  return getNumber(firstLevel, ['price']);
}

function addBoundedKey(
  knownKeys: Set<string>,
  keyOrder: string[],
  key: string,
  maxEntries: number,
): void {
  if (knownKeys.has(key)) {
    return;
  }

  knownKeys.add(key);
  keyOrder.push(key);

  while (keyOrder.length > maxEntries) {
    const oldestKey = keyOrder.shift();
    if (oldestKey) {
      knownKeys.delete(oldestKey);
    }
  }
}

async function runWithRetries<T>(
  label: string,
  operation: () => Promise<T>,
  attempts = CAPTURE_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }

      await sleep(CAPTURE_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }

  throw new Error(`${label} failed after ${attempts} attempts`, { cause: lastError });
}

function warnCaptureStep(error: unknown, label: string): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[phase0] ${label} failed: ${message}\n`);
}
