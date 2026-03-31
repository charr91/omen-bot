import { parentPort, workerData } from 'node:worker_threads';
import type { AppConfig } from '../config/schema.js';
import { ActiveMarketCatalog } from '../markets/catalog.js';
import { createDbPool } from '../persistence/db.js';
import { createFillStore } from '../persistence/queries/fills.js';
import { createSignalEventStore } from '../persistence/queries/signal-events.js';
import { createWalletStore } from '../persistence/queries/wallets.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';
import { AlchemyWalletProfiler } from '../profiling/wallet-profiler.js';
import { computeCompositeLiveScore, evaluateLiveSignals } from '../signals/evaluate-live-signals.js';
import { deriveAlertTier } from '../signals/scoring.js';
import type { FillRecord } from '../types/fill.js';
import type { HotWorkerToMainMessage, MainToHotWorkerMessage } from '../types/thread-messages.js';
import type { WalletProfile } from '../types/wallet.js';
import { HOT_WORKER_HEARTBEAT_INTERVAL_MS, HOT_WORKER_HEARTBEAT_KEY, HOT_WORKER_HEARTBEAT_TTL_MS } from './constants.js';

interface HotWorkerData {
  config: AppConfig;
}

const port = parentPort;
if (!port) {
  throw new Error('Hot worker runtime started without a parent port');
}
const workerPort = port;

const { config } = workerData as HotWorkerData;
if (!config.alchemyApiKey) {
  throw new Error('ALCHEMY_API_KEY is required to start the hot worker');
}

const pool = createDbPool(config);
const fillStore = createFillStore(pool);
const walletStore = createWalletStore(pool);
const signalEventStore = createSignalEventStore(pool);
const redis = createRedisClient(config);
const walletProfiler = new AlchemyWalletProfiler(config.alchemyApiKey);
const marketCatalog = new ActiveMarketCatalog();
const queue: FillRecord[] = [];
const queuedFillIds = new Set<string>();

let processing = false;
let stopping = false;
let lastProcessedAt: string | null = null;

void start();

async function start(): Promise<void> {
  await pingRedis(redis);
  const heartbeatTimer = setInterval(() => {
    void emitHeartbeatSafely('heartbeat timer');
  }, HOT_WORKER_HEARTBEAT_INTERVAL_MS);

  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  workerPort.on('message', (message: MainToHotWorkerMessage) => {
    void handleMessage(message).catch((error) => {
      postMessage({
        type: 'ERROR',
        error: formatError(error),
        fillId: null,
      });
    });
  });

  await emitHeartbeat();
}

async function handleMessage(message: MainToHotWorkerMessage): Promise<void> {
  if (message.type === 'STOP') {
    stopping = true;
    if (!processing && queue.length === 0) {
      await shutdown();
    }
    return;
  }

  if (queuedFillIds.has(message.fill.id)) {
    postMessage({
      type: 'ENQUEUE_RESULT',
      fillId: message.fill.id,
      result: 'duplicate',
    });
    return;
  }

  if (queue.length >= config.backpressure.hotWorkerQueueDepth) {
    postMessage({
      type: 'ENQUEUE_RESULT',
      fillId: message.fill.id,
      result: 'full',
    });
    return;
  }

  queue.push(message.fill);
  queuedFillIds.add(message.fill.id);
  postMessage({
    type: 'ENQUEUE_RESULT',
    fillId: message.fill.id,
    result: 'accepted',
  });
  kickProcessQueue();
  await emitHeartbeatSafely('enqueue accepted fill', message.fill.id);
}

async function processQueue(): Promise<void> {
  if (processing) {
    return;
  }

  processing = true;
  try {
    while (queue.length > 0) {
      const fill = queue.shift();
      if (!fill) {
        continue;
      }

      try {
        await processFill(fill);
        lastProcessedAt = new Date().toISOString();
        postMessage({
          type: 'FILL_RESULT',
          fillId: fill.id,
          status: 'processed',
          error: null,
        });
      } catch (error) {
        postMessage({
          type: 'FILL_RESULT',
          fillId: fill.id,
          status: 'failed',
          error: formatError(error),
        });
        postMessage({
          type: 'ERROR',
          fillId: fill.id,
          error: formatError(error),
        });
      } finally {
        queuedFillIds.delete(fill.id);
        await emitHeartbeatSafely('fill completion', fill.id);
      }
    }
  } finally {
    processing = false;
    await emitHeartbeatSafely('queue idle');
    if (stopping) {
      await shutdown();
    }
  }
}

async function processFill(fill: FillRecord): Promise<void> {
  await walletStore.upsertWalletStub(fill.walletAddress, fill.timestamp);

  const [aggregateStats, isWhitelisted, chainProfile] = await Promise.all([
    walletStore.getAggregateStats(fill.walletAddress),
    walletStore.isWhitelisted(fill.walletAddress),
    walletProfiler.profileWallet(fill.walletAddress),
  ]);

  const market = await marketCatalog.getMarket(fill.marketId);

  const baseWallet: WalletProfile = {
    address: fill.walletAddress,
    ageSeconds: chainProfile.ageSeconds,
    activityAgeKnown: chainProfile.activityAgeKnown,
    totalTransactions: chainProfile.totalTransactions,
    isContract: chainProfile.isContract,
    controllerAddress: chainProfile.controllerAddress,
    firstSeenAt: chainProfile.firstActivityAt ?? fill.timestamp,
    lastActiveAt: fill.timestamp,
    totalMarkets: aggregateStats.totalMarkets,
    totalFills: aggregateStats.totalFills,
    totalVolumeUsd: aggregateStats.totalVolumeUsd,
    liveSuspicionScore: 0,
    liveTier: 'CLEAN',
    isWhitelisted,
  };

  const triggeredSignals = evaluateLiveSignals({
    fill,
    wallet: baseWallet,
    market,
    config,
  });

  const liveScore = computeCompositeLiveScore(triggeredSignals);
  const liveTier = deriveAlertTier(liveScore, config);
  const walletProfile: WalletProfile = {
    ...baseWallet,
    liveSuspicionScore: liveScore,
    liveTier,
  };

  await walletStore.upsertLiveProfile(walletProfile);

  if (market !== null) {
    for (const signal of triggeredSignals) {
      const inserted = await signalEventStore.insertLiveSignalEvent({
        walletAddress: fill.walletAddress,
        marketId: fill.marketId,
        fillId: fill.id,
        signal,
      });

      if (inserted) {
        postMessage({
          type: 'SIGNAL_PREVIEW',
          fillId: fill.id,
          walletAddress: fill.walletAddress,
          marketId: fill.marketId,
          marketQuestion: market.question,
          walletLiveScore: walletProfile.liveSuspicionScore,
          walletLiveTier: walletProfile.liveTier,
          signal,
          dryRun: config.operational.dryRun,
        });
      }
    }
  }

  await fillStore.markFillAnalyzed(fill.id);
}

async function emitHeartbeat(): Promise<void> {
  const at = new Date().toISOString();
  await redis.set(
    HOT_WORKER_HEARTBEAT_KEY,
    JSON.stringify({
      at,
      queueDepth: queue.length,
      processing,
      lastProcessedAt,
    }),
    'PX',
    HOT_WORKER_HEARTBEAT_TTL_MS,
  );
  postMessage({
    type: 'HEARTBEAT',
    at,
    queueDepth: queue.length,
    processing,
    lastProcessedAt,
  });
}

async function emitHeartbeatSafely(context: string, fillId: string | null = null): Promise<void> {
  try {
    await emitHeartbeat();
  } catch (error) {
    postMessage({
      type: 'ERROR',
      error: `failed to emit hot-worker heartbeat during ${context}: ${formatError(error)}`,
      fillId,
    });
  }
}

function kickProcessQueue(): void {
  void processQueue().catch((error) => {
    postMessage({
      type: 'ERROR',
      error: `hot-worker queue processor crashed: ${formatError(error)}`,
      fillId: null,
    });
  });
}

async function shutdown(): Promise<void> {
  try {
    await emitHeartbeat();
  } catch {
    // Ignore final heartbeat failures during shutdown.
  }

  redis.disconnect(false);
  await pool.end();
  workerPort.close();
}

function postMessage(message: HotWorkerToMainMessage): void {
  workerPort.postMessage(message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
