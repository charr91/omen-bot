import { resolve } from 'node:path';
import { z } from 'zod';
import { createAuthenticatedTradeReader } from './auth.js';
import {
  ANALYSIS_DIRECTORY_NAME,
  AUTH_TRADE_POLL_INTERVAL_MS,
  AUTH_TRADES_FILE_NAME,
  CAPTURE_LOG_FILE_NAME,
  CAPTURE_RETRY_ATTEMPTS,
  CAPTURE_RETRY_BASE_MS,
  CAPTURE_STATE_FILE_NAME,
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
import {
  createJsonlWriter,
  ensureDirectory,
  readJsonFile,
  scanJsonLines,
  sleep,
  writeJsonFile,
  writeTextFile,
} from './io.js';
import { asJsonObject, getJsonArray, getJsonObject, getNumber, getString } from './json.js';
import { captureManifestSchema } from './manifest.js';
import { fetchActiveAssets, fetchOrderBooks, fetchPublicTrades } from './public-api.js';
import { startMarketWsCapture, type WsCaptureController } from './ws.js';
import type {
  ActiveAsset,
  CaptureManifest,
  CaptureRunState,
  JsonLineEnvelope,
  JsonObject,
} from './types.js';

interface CaptureOptions {
  hours: number;
  out: string;
  useAuth: boolean;
}

interface NewPublicTrade {
  key: string;
  trade: JsonObject;
}

interface HydratedCaptureRun {
  manifest: CaptureManifest;
  observedAssets: Map<string, ActiveAsset>;
  seenPublicTradeKeys: Set<string>;
  seenPublicTradeKeyOrder: string[];
  seenAuthTradeIds: Set<string>;
  resumedFromExisting: boolean;
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

  const hydrated = await hydrateCaptureRun(runDirectory, options, assetsById, {
    activeAssets: discovery.assets.length,
    activeMarkets: discovery.marketCount,
  });
  const manifest = hydrated.manifest;
  const observedAssets = hydrated.observedAssets;
  const seenPublicTradeKeys = hydrated.seenPublicTradeKeys;
  const seenPublicTradeKeyOrder = hydrated.seenPublicTradeKeyOrder;
  const seenAuthTradeIds = hydrated.seenAuthTradeIds;

  await persistManifest(runDirectory, manifest);

  const runState: CaptureRunState = {
    version: PHASE0_VERSION,
    status: 'running',
    runDirectory,
    startedAt: manifest.startedAt,
    updatedAt: new Date().toISOString(),
    completedAt: null,
    requestedHours: manifest.requestedHours,
    useAuth: manifest.useAuth,
    pid: process.pid,
    resumedFromExisting: hydrated.resumedFromExisting,
    counts: { ...manifest.counts },
    lastStep: hydrated.resumedFromExisting ? 'resume' : 'initialize',
    lastError: null,
  };
  await persistCaptureState(runDirectory, runState);

  const publicTradeWriter = createJsonlWriter<JsonLineEnvelope>(resolve(rawDirectory, PUBLIC_TRADES_FILE_NAME));
  const orderBookWriter = createJsonlWriter<JsonLineEnvelope>(resolve(rawDirectory, ORDER_BOOKS_FILE_NAME));
  const wsWriter = createJsonlWriter<JsonLineEnvelope>(resolve(rawDirectory, WS_MESSAGES_FILE_NAME));
  const authWriter = createJsonlWriter<JsonLineEnvelope>(resolve(rawDirectory, AUTH_TRADES_FILE_NAME));

  let wsController: WsCaptureController | null = null;
  let completedSuccessfully = false;
  let lastFailure: unknown = null;

  const readAuthenticatedTrades = await createAuthenticatedTradeReader(options.useAuth);
  const endTimeMs = Date.parse(manifest.startedAt) + manifest.requestedHours * 60 * 60 * 1000;
  let lastAuthPollAt = 0;
  let pollId = 0;

  try {
    while (Date.now() < endTimeMs) {
      pollId += 1;
      runState.lastStep = `poll:${pollId}`;
      runState.updatedAt = new Date().toISOString();
      await persistCaptureState(runDirectory, runState);

      const capturedAt = new Date().toISOString();
      const publicTrades = await runWithRetries(
        'fetch public trades',
        () => fetchVisiblePublicTrades(seenPublicTradeKeys),
      ).catch(async (error: unknown) => {
        await warnAndRecordCaptureStep(runDirectory, runState, manifest, 'public trades', error);
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
        const activeWsController = await ensureWsController(wsController, async () =>
          runWithRetries('start market websocket', () =>
            startMarketWsCapture({
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
              onError: async (error, label) => {
                await warnAndRecordCaptureStep(runDirectory, runState, manifest, label, error);
              },
            }),
          ).catch(async (error: unknown) => {
            await warnAndRecordCaptureStep(runDirectory, runState, manifest, 'websocket startup', error);
            return null;
          }),
        );
        wsController = activeWsController;

        try {
          await activeWsController?.subscribe([...assetIds]);
        } catch (error) {
          await warnAndRecordCaptureStep(runDirectory, runState, manifest, 'websocket subscribe', error);
          if (wsController) {
            await wsController.stop().catch(() => undefined);
            wsController = null;
          }
        }

        const orderBooks = await runWithRetries(
          'fetch order books',
          () => fetchOrderBooks([...assetIds]),
        ).catch(async (error: unknown) => {
          await warnAndRecordCaptureStep(runDirectory, runState, manifest, 'order books', error);
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
        ).catch(async (error: unknown) => {
          await warnAndRecordCaptureStep(runDirectory, runState, manifest, 'authenticated trades', error);
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
      runState.counts = { ...manifest.counts };
      runState.updatedAt = new Date().toISOString();
      runState.lastStep = `sleep:${pollId}`;
      runState.lastError = null;
      await persistCaptureState(runDirectory, runState);

      const remainingMs = endTimeMs - Date.now();
      if (remainingMs > 0) {
        await sleep(Math.min(PUBLIC_TRADE_POLL_INTERVAL_MS, remainingMs));
      }
    }

    completedSuccessfully = true;
  } catch (error) {
    lastFailure = error;
    throw error;
  } finally {
    await wsController?.stop().catch((error) => {
      process.stderr.write(`[phase0] websocket shutdown failed: ${String(error)}\n`);
    });
    await publicTradeWriter.close().catch((error) => {
      process.stderr.write(`[phase0] public writer close failed: ${String(error)}\n`);
    });
    await orderBookWriter.close().catch((error) => {
      process.stderr.write(`[phase0] order book writer close failed: ${String(error)}\n`);
    });
    await wsWriter.close().catch((error) => {
      process.stderr.write(`[phase0] websocket writer close failed: ${String(error)}\n`);
    });
    await authWriter.close().catch((error) => {
      process.stderr.write(`[phase0] auth writer close failed: ${String(error)}\n`);
    });

    runState.counts = { ...manifest.counts };
    runState.updatedAt = new Date().toISOString();

    if (completedSuccessfully) {
      manifest.completedAt = new Date().toISOString();
      await persistManifest(runDirectory, manifest);
      await writeJsonFile(resolve(runDirectory, OBSERVED_ASSETS_FILE_NAME), {
        assets: [...observedAssets.values()],
      });
      await writeJsonFile(resolve(analysisDirectory, SUMMARY_FILE_NAME), { status: 'pending-analysis' });
      await writeTextFile(
        resolve(analysisDirectory, FINDINGS_FILE_NAME),
        'Run `omen validate-fills analyze --input <runDir>` after capture completes.',
      );

      runState.status = 'completed';
      runState.completedAt = manifest.completedAt;
      runState.lastStep = 'completed';
      runState.lastError = null;
      await persistCaptureState(runDirectory, runState);
    } else {
      runState.status = 'failed';
      runState.completedAt = null;
      runState.lastStep = 'failed';
      runState.lastError = formatError(lastFailure);
      await persistCaptureState(runDirectory, runState);
    }
  }

  return {
    runDirectory,
  };
}

export async function hydrateCaptureRun(
  runDirectory: string,
  options: CaptureOptions,
  assetsById: ReadonlyMap<string, ActiveAsset>,
  discovery: CaptureManifest['discovery'],
): Promise<HydratedCaptureRun> {
  const manifestPath = resolve(runDirectory, MANIFEST_FILE_NAME);

  const observedAssets = new Map<string, ActiveAsset>();
  const seenPublicTradeKeys = new Set<string>();
  const seenPublicTradeKeyOrder: string[] = [];
  const seenAuthTradeIds = new Set<string>();

  if (!await fileExists(manifestPath)) {
    return {
      manifest: {
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
        discovery,
        counts: {
          publicTradeObservations: 0,
          orderBookSnapshots: 0,
          wsMessages: 0,
          authTradeObservations: 0,
        },
      },
      observedAssets,
      seenPublicTradeKeys,
      seenPublicTradeKeyOrder,
      seenAuthTradeIds,
      resumedFromExisting: false,
    };
  }

  const existingManifest = captureManifestSchema.parse(await readJsonFile(manifestPath));
  if (existingManifest.completedAt !== null) {
    throw new Error(
      `Capture output ${runDirectory} already completed at ${existingManifest.completedAt}. Use analyze or choose a new --out path.`,
    );
  }
  if (existingManifest.requestedHours !== options.hours) {
    throw new Error(
      `Capture output ${runDirectory} was started with --hours ${existingManifest.requestedHours}; rerun with the same value to resume it.`,
    );
  }
  if (existingManifest.useAuth !== options.useAuth) {
    throw new Error(
      `Capture output ${runDirectory} was started with --use-auth=${existingManifest.useAuth}; rerun with the same auth mode to resume it.`,
    );
  }

  const counts = {
    publicTradeObservations: 0,
    orderBookSnapshots: 0,
    wsMessages: 0,
    authTradeObservations: 0,
  };

  await scanJsonLines(resolve(runDirectory, RAW_DIRECTORY_NAME, PUBLIC_TRADES_FILE_NAME), async (value) => {
    counts.publicTradeObservations += 1;
    const envelope = asJsonObject(value, 'public trade envelope');
    const payload = getJsonObject(envelope, ['payload']);
    if (!payload) {
      return;
    }

    const assetId = getString(payload, ['asset']);
    if (assetId) {
      const metadata = assetsById.get(assetId);
      if (metadata) {
        observedAssets.set(assetId, metadata);
      }
    }

    addBoundedKey(
      seenPublicTradeKeys,
      seenPublicTradeKeyOrder,
      stableTradeObservationKey(payload),
      MAX_PUBLIC_TRADE_KEY_WINDOW,
    );
  });

  await scanJsonLines(resolve(runDirectory, RAW_DIRECTORY_NAME, ORDER_BOOKS_FILE_NAME), async () => {
    counts.orderBookSnapshots += 1;
  });

  await scanJsonLines(resolve(runDirectory, RAW_DIRECTORY_NAME, WS_MESSAGES_FILE_NAME), async () => {
    counts.wsMessages += 1;
  });

  await scanJsonLines(resolve(runDirectory, RAW_DIRECTORY_NAME, AUTH_TRADES_FILE_NAME), async (value) => {
    counts.authTradeObservations += 1;
    const envelope = asJsonObject(value, 'auth trade envelope');
    const payload = getJsonObject(envelope, ['payload']);
    const tradeId = payload ? getString(payload, ['id']) : null;
    if (tradeId) {
      seenAuthTradeIds.add(tradeId);
    }
  });

  return {
    manifest: {
      ...existingManifest,
      runDirectory,
      discovery,
      counts,
    },
    observedAssets,
    seenPublicTradeKeys,
    seenPublicTradeKeyOrder,
    seenAuthTradeIds,
    resumedFromExisting: true,
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

    const reachedPaginationLimit = offset + pageSize > maxOffset;
    if (reachedPaginationLimit && page.length === pageSize && newTradesInPage.length > 0) {
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

async function persistCaptureState(runDirectory: string, state: CaptureRunState): Promise<void> {
  await writeJsonFile(resolve(runDirectory, CAPTURE_STATE_FILE_NAME), state);
}

async function warnAndRecordCaptureStep(
  runDirectory: string,
  state: CaptureRunState,
  manifest: CaptureManifest,
  label: string,
  error: unknown,
): Promise<void> {
  warnCaptureStep(error, label);
  state.status = 'running';
  state.updatedAt = new Date().toISOString();
  state.counts = { ...manifest.counts };
  state.lastStep = `warn:${label}`;
  state.lastError = `${label}: ${formatError(error)}`;
  await persistCaptureState(runDirectory, state);
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await readJsonFile(pathname);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return false;
    }
    throw error;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
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

async function ensureWsController(
  controller: WsCaptureController | null,
  startController: () => Promise<WsCaptureController | null>,
): Promise<WsCaptureController | null> {
  if (controller) {
    return controller;
  }

  return startController();
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

export function defaultDetachedCaptureLogPath(out: string): string {
  return resolve(out, CAPTURE_LOG_FILE_NAME);
}
