import { promoteSignalPreview } from '../alerts/promote.js';
import { buildPolymarketMarketUrl } from '../alerts/links.js';
import { isDiscordEnabledForTier } from '../alerts/discord.js';
import { isTelegramEnabledForTier } from '../alerts/telegram.js';
import { parentPort, workerData } from 'node:worker_threads';
import { createFundingGraphRebuildJobQueue } from '../cold-path/queue.js';
import type { AppConfig } from '../config/schema.js';
import { resolveWalletChainProfile } from './chain-profile.js';
import { ActiveMarketCatalog } from '../markets/catalog.js';
import { createDbPool } from '../persistence/db.js';
import { createAuditLogStore } from '../persistence/queries/audit-log.js';
import { createAlertStore } from '../persistence/queries/alerts.js';
import { createFillStore } from '../persistence/queries/fills.js';
import { createProxyOverrideStore } from '../persistence/queries/proxy-overrides.js';
import { createSignalEventStore } from '../persistence/queries/signal-events.js';
import { createWalletStore, type WalletSignalContext } from '../persistence/queries/wallets.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';
import { ALCHEMY_BUDGET_EXHAUSTED, AlchemyWalletProfiler } from '../profiling/wallet-profiler.js';
import { createMarketMakerStore } from '../persistence/queries/market-maker.js';
import { AlchemyDailyBudget, startCuMeterFlush } from '../resilience/cu-meter.js';
import { effectiveMinProfileFillUsd, shouldProfileFill } from './profile-gate.js';
import { computeCompositeLiveScore, evaluateLiveSignals } from '../signals/evaluate-live-signals.js';
import type { LiveClusterSignalContext } from '../signals/sybil-cluster.js';
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
const noAlchemyMode = !config.alchemyApiKey && process.env.OMEN_ALLOW_MISSING_ALCHEMY === 'true';
if (!config.alchemyApiKey && !noAlchemyMode) {
  throw new Error('ALCHEMY_API_KEY is required to start the hot worker');
}
let noAlchemyNoticeSent = false;

const pool = createDbPool(config);
const alertStore = createAlertStore(pool);
const fillStore = createFillStore(pool);
const walletStore = createWalletStore(pool);
const auditLogStore = createAuditLogStore(pool);
const proxyOverrideStore = createProxyOverrideStore(pool);
const signalEventStore = createSignalEventStore(pool);
const marketMakerStore = createMarketMakerStore(pool);
const redis = createRedisClient(config);
const stopCuMeter = startCuMeterFlush(redis, 'hot');
const hotBudget = new AlchemyDailyBudget(redis, {
  dailyCu: config.alchemy.dailyCuBudget,
  share: config.alchemy.hotBudgetShare,
  component: 'hot',
});
let hotBudgetNoticeDay: string | null = null;
const walletProfiler = new AlchemyWalletProfiler(config.alchemyApiKey, {
  cacheTtlMs: config.alchemy.profileCacheTtlMs,
  budgetExhausted: () => hotBudget.isExhausted(),
  controllerCacheTtlMs: config.alchemy.profileCacheTtlMs,
  maxCacheEntries: 20_000,
  rateLimit: {
    cuPerSecond: config.alchemy.hotCuPerSecond,
    maxWaitMs: config.alchemy.maxWaitMs,
    maxQueue: config.alchemy.maxQueue,
    max429Retries: config.alchemy.max429Retries,
  },
});
const minProfileFillUsd = effectiveMinProfileFillUsd(config);
const marketCatalog = new ActiveMarketCatalog();
const coldPathQueue = createFundingGraphRebuildJobQueue(config);
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
    // Finish only the in-flight fill. Queued fills stay unanalyzed in Postgres and are replayed on next start.
    queue.length = 0;
    queuedFillIds.clear();
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
    while (queue.length > 0 && !stopping) {
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

  if (!shouldProfileFill(fill.sizeUsd, minProfileFillUsd)) {
    // Below every live signal's min fill size: no signal can fire, so skip Alchemy profiling, controller
    // lookup and funding-graph rebuilds. The stored wallet profile is left untouched (not downgraded).
    await fillStore.markFillAnalyzed(fill.id);
    return;
  }

  const [aggregateStats, signalContext, isWhitelisted, resolvedChainProfile] = await Promise.all([
    walletStore.getAggregateStats(fill.walletAddress, { fillId: fill.id, fillTimestamp: fill.timestamp }),
    walletStore.getSignalContext(fill.walletAddress),
    walletStore.isWhitelisted(fill.walletAddress),
    resolveWalletChainProfile({
      walletAddress: fill.walletAddress,
      profiler: walletProfiler,
    }),
  ]);
  const chainProfile = resolvedChainProfile.profile;

  if (resolvedChainProfile.degraded && noAlchemyMode) {
    // box-dry-run: report no-Alchemy degradation once instead of once per fill.
    if (!noAlchemyNoticeSent) {
      noAlchemyNoticeSent = true;
      postMessage({
        type: 'ERROR',
        fillId: fill.id,
        error: '[alchemy] no-Alchemy mode: all wallet profiles use conservative fallback (reported once)',
      });
    }
  } else if (resolvedChainProfile.degraded && resolvedChainProfile.error?.includes(ALCHEMY_BUDGET_EXHAUSTED)) {
    const day = new Date().toISOString().slice(0, 10);
    if (hotBudgetNoticeDay !== day) {
      hotBudgetNoticeDay = day;
      postMessage({
        type: 'ERROR',
        fillId: fill.id,
        error: `[alchemy] hot daily CU budget (${hotBudget.limitCu}) exhausted for ${day} UTC; uncached wallets use the conservative profile until 00:00 UTC (reported once per day)`,
      });
    }
  } else if (resolvedChainProfile.degraded) {
    postMessage({
      type: 'ERROR',
      fillId: fill.id,
      error: `[alchemy] profile degraded for ${fill.walletAddress}; using conservative fallback: ${resolvedChainProfile.error}`,
    });
  }

  const market = await marketCatalog.getMarket(fill.marketId);
  const effectiveChainProfile = await buildEffectiveChainProfile(fill.walletAddress, chainProfile);
  const cluster = await buildFundingClusterContext(fill, signalContext);

  const baseWallet: WalletProfile = {
    address: fill.walletAddress,
    ageSeconds: effectiveChainProfile.ageSeconds,
    activityAgeKnown: effectiveChainProfile.activityAgeKnown,
    totalTransactions: effectiveChainProfile.totalTransactions,
    isContract: effectiveChainProfile.isContract,
    controllerAddress: effectiveChainProfile.controllerAddress,
    freshnessAgeSeconds: effectiveChainProfile.freshnessAgeSeconds,
    freshnessActivityAgeKnown: effectiveChainProfile.freshnessActivityAgeKnown,
    freshnessTotalTransactions: effectiveChainProfile.freshnessTotalTransactions,
    firstSeenAt: effectiveChainProfile.firstActivityAt ?? fill.timestamp,
    lastActiveAt: fill.timestamp,
    totalMarkets: aggregateStats.totalMarkets,
    totalFills: aggregateStats.totalFills,
    totalVolumeUsd: aggregateStats.totalVolumeUsd,
    fundingClusterId: signalContext.fundingClusterId,
    liveSuspicionScore: 0,
    liveTier: 'CLEAN',
    isWhitelisted,
  };

  const evaluatedSignals = evaluateLiveSignals({
    fill,
    wallet: baseWallet,
    market,
    config,
    cluster,
  });
  // insider-poly-bot port: likely market makers (balanced, high-frequency, multi-market) produce no live signals.
  const marketMakerScore =
    evaluatedSignals.length > 0 && config.marketMaker.filterEnabled
      ? await marketMakerStore.getScore(fill.walletAddress, fill.timestamp)
      : 0;
  const triggeredSignals = marketMakerScore >= config.marketMaker.minScore ? [] : evaluatedSignals;
  if (triggeredSignals.length !== evaluatedSignals.length) {
    postMessage({
      type: 'ERROR',
      fillId: fill.id,
      error: `[mm-filter] suppressed ${evaluatedSignals.length} signal(s) for likely market maker ${fill.walletAddress} (score ${marketMakerScore})`,
    });
  }

  const liveScore = computeCompositeLiveScore(triggeredSignals);
  const liveTier = deriveAlertTier(liveScore, config);
  const walletProfile: WalletProfile = {
    ...baseWallet,
    liveSuspicionScore: liveScore,
    liveTier,
  };

  await walletStore.upsertLiveProfile(walletProfile);
  await maybeRecordControllerAttribution(fill.walletAddress, signalContext.controllerAddress, effectiveChainProfile);

  if (market !== null) {
    for (const signal of triggeredSignals) {
      const inserted = await signalEventStore.insertLiveSignalEvent({
        walletAddress: fill.walletAddress,
        marketId: fill.marketId,
        fillId: fill.id,
        signal,
      });

      if (inserted) {
        const preview = {
          fillId: fill.id,
          walletAddress: fill.walletAddress,
          marketId: fill.marketId,
          marketQuestion: market.question,
          marketUrl: buildPolymarketMarketUrl(market.eventSlug, market.marketSlug),
          fillSide: fill.side,
          fillOutcome: fill.outcome,
          fillPrice: fill.price,
          fillSizeUsd: fill.sizeUsd,
          fillTimestamp: fill.timestamp.toISOString(),
          walletLiveScore: walletProfile.liveSuspicionScore,
          walletLiveTier: walletProfile.liveTier,
          signal,
          promotedAlertId: null,
          promotedAt: null,
          dryRun: config.operational.dryRun,
        } as const;
        const promotedAlert = promoteSignalPreview(preview);
        const storedAlert =
          promotedAlert === null
            ? null
            : await alertStore.upsertPromotedAlert(
                promotedAlert,
                isAlertDispatchEligible(config, promotedAlert.deliveryTier),
              );

        postMessage({
          type: 'SIGNAL_PREVIEW',
          ...preview,
          promotedAlertId: storedAlert?.id ?? null,
          promotedAt: storedAlert?.promotedAt ?? null,
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

  await stopCuMeter();
  await coldPathQueue.close();
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

function isAlertDispatchEligible(
  appConfig: Pick<AppConfig, 'operational' | 'telegram' | 'discord'>,
  tier: Exclude<WalletProfile['liveTier'], 'CLEAN'>,
): boolean {
  if (appConfig.operational.dryRun) {
    return false;
  }

  return (
    isTelegramEnabledForTier({ telegram: appConfig.telegram }, tier) ||
    isDiscordEnabledForTier({ discord: appConfig.discord }, tier)
  );
}

async function buildEffectiveChainProfile(
  walletAddress: string,
  chainProfile: Awaited<ReturnType<AlchemyWalletProfiler['profileWallet']>>,
): Promise<Awaited<ReturnType<AlchemyWalletProfiler['profileWallet']>>> {
  if (!chainProfile.isContract) {
    return chainProfile;
  }

  let manualOverride: Awaited<ReturnType<typeof proxyOverrideStore.getOverride>>;
  let controllerAddress: string | null;
  try {
    manualOverride = await proxyOverrideStore.getOverride(walletAddress);
    controllerAddress =
      manualOverride?.controllerAddress ?? (await walletProfiler.resolveControllerAddress(walletAddress));
  } catch (error) {
    if (!formatError(error).includes(ALCHEMY_BUDGET_EXHAUSTED)) {
      postMessage({
        type: 'ERROR',
        fillId: null,
        error: `[proxy] failed to resolve controller for ${walletAddress}: ${formatError(error)}`,
      });
    }
    return {
      ...chainProfile,
      ageSeconds: 0,
      activityAgeKnown: false,
      controllerAddress: null,
      freshnessAgeSeconds: 0,
      freshnessActivityAgeKnown: false,
      freshnessTotalTransactions: 0,
      firstActivityAt: null,
    };
  }

  if (!controllerAddress) {
    return {
      ...chainProfile,
      ageSeconds: 0,
      activityAgeKnown: false,
      controllerAddress: null,
      freshnessAgeSeconds: 0,
      freshnessActivityAgeKnown: false,
      freshnessTotalTransactions: 0,
      firstActivityAt: null,
    };
  }

  const resolvedControllerProfile = await resolveWalletChainProfile({
    walletAddress: controllerAddress,
    profiler: walletProfiler,
  });
  const controllerProfile = resolvedControllerProfile.profile;
  return {
    ...controllerProfile,
    isContract: true,
    controllerAddress,
    freshnessAgeSeconds: controllerProfile.freshnessAgeSeconds,
    freshnessActivityAgeKnown: controllerProfile.freshnessActivityAgeKnown,
    freshnessTotalTransactions: controllerProfile.freshnessTotalTransactions,
  };
}

async function buildFundingClusterContext(
  fill: FillRecord,
  signalContext: WalletSignalContext,
): Promise<LiveClusterSignalContext | null> {
  const fundingGraphBuiltAt = signalContext.fundingGraphBuiltAt;
  const graphFresh =
    fundingGraphBuiltAt !== null && fill.timestamp.getTime() - fundingGraphBuiltAt.getTime() < 24 * 60 * 60_000;

  if (!graphFresh) {
    try {
      await coldPathQueue.requestRebuild(fill.walletAddress);
    } catch (error) {
      postMessage({
        type: 'ERROR',
        error: `failed to enqueue funding-graph rebuild: ${formatError(error)}`,
        fillId: fill.id,
      });
    }
  }

  if (signalContext.fundingClusterId === null) {
    return null;
  }

  const clusterMembers = await walletStore.listFundingClusterMembers(signalContext.fundingClusterId);
  if (clusterMembers.length === 0) {
    return null;
  }

  const sameMarketSameSideEntries = await fillStore.countDistinctWalletsForMarketSideWindow(
    fill.marketId,
    fill.side,
    clusterMembers,
    new Date(fill.timestamp.getTime() - config.detection.cluster.sameMarketSameSideWindowMs),
    fill.timestamp,
  );

  return {
    fundingClusterId: signalContext.fundingClusterId,
    clusterSize: clusterMembers.length,
    sameMarketSameSideEntries,
  };
}

async function maybeRecordControllerAttribution(
  walletAddress: string,
  previousControllerAddress: string | null,
  chainProfile: Awaited<ReturnType<AlchemyWalletProfiler['profileWallet']>>,
): Promise<void> {
  if (!chainProfile.isContract || chainProfile.controllerAddress === null) {
    return;
  }

  if (chainProfile.controllerAddress === previousControllerAddress) {
    return;
  }

  const manualOverride = await proxyOverrideStore.getOverride(walletAddress);
  await auditLogStore.append({
    action: 'PROXY_ATTRIBUTE',
    targetAddress: walletAddress,
    actor: manualOverride ? 'manual' : 'auto',
    oldValue:
      previousControllerAddress === null
        ? null
        : {
            controllerAddress: previousControllerAddress,
          },
    newValue: {
      controllerAddress: chainProfile.controllerAddress,
    },
    reason: manualOverride ? manualOverride.reason : 'automatic proxy controller attribution',
  });
}
