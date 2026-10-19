import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { enrichAlertWithLinkedTradeContext } from '../alerts/context.js';
import type { AlertDispatchResult } from '../alerts/channel.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';
import { buildPolymarketMarketUrl } from '../alerts/links.js';
import { promoteSignalPreview } from '../alerts/promote.js';
import { createFundingGraphRebuildJobQueue } from '../cold-path/queue.js';
import { ColdWorkerSupervisor } from '../cold-path/supervisor.js';
import { loadAppConfig } from '../config/index.js';
import { HotWorkerClient } from '../hot-worker/client.js';
import { createPolymarketFillSource, type FillSource } from '../ingestion/polymarket-client.js';
import { createAppLogger, emitStructuredLog } from '../logging/logger.js';
import { ActiveMarketCatalog } from '../markets/catalog.js';
import { RuntimeStatsCollector } from './runtime-stats.js';
import { createDbPool } from '../persistence/db.js';
import { createAlertStore, type AlertStore, type PendingStoredAlert } from '../persistence/queries/alerts.js';
import { createFillStore, type FillStore } from '../persistence/queries/fills.js';
import { createIngestQuarantineStore } from '../persistence/queries/ingest-quarantine.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';
import { readAlchemyCuUsage } from '../resilience/cu-meter.js';
import { OutcomeTracker } from '../outcomes/tracker.js';
import { FeedClient, XBridge, loadXOptions } from '@charr91/smart-money-feed';
import { annotatePendingAlerts, recordXRequest, xRequestForAlert } from '../feed/x-enrich.js';
import { Pool as PgPool } from 'pg';
import { liveAlertEnvelope, syncOutcomesToFeed } from '../feed/publisher.js';
import { isSignalDeliverable } from '../signals/delivery.js';
import { KalshiClient } from '../kalshi/client.js';
import { KalshiService } from '../kalshi/service.js';
import { readMarketExclusions } from '../markets/exclusion-stats.js';
import { createKalshiStore } from '../kalshi/store.js';
import { createTradeOutcomeStore } from '../outcomes/store.js';
import { createMarketMakerStore } from '../persistence/queries/market-maker.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { collectHealthReport } from '../resilience/health.js';
import { TerminalDashboard } from '../tui/dashboard.js';
import type { PromotedAlert, SignalPreview, StoredAlert } from '../types/alert.js';
import type { FillRecord } from '../types/fill.js';
import type { EnqueueFillResult, HotWorkerToMainMessage } from '../types/thread-messages.js';

export interface FillAnalysisQueue {
  enqueue(fill: FillRecord): Promise<EnqueueFillResult>;
}

export interface ReplayAnalysisQueue extends FillAnalysisQueue {
  waitForIdle(timeoutMs?: number): Promise<void>;
}

export interface IngestionCycleResult {
  checkpoint: string | null;
  fetched: number;
  inserted: number;
  replayed: number;
}

interface IngestionCycleOptions {
  fillSource: FillSource;
  fillStore: FillStore;
  analysisQueue: FillAnalysisQueue;
  replayLimit?: number;
}

interface StartCommandOptions {
  tui?: boolean;
}

const DEFAULT_REPLAY_LIMIT = 1_000;
const DEFAULT_PENDING_ALERT_BATCH_LIMIT = 1_000;
const RUNTIME_STATS_INTERVAL_MS = 60_000;
type SignalPreviewMessage = Extract<HotWorkerToMainMessage, { type: 'SIGNAL_PREVIEW' }>;

export async function runIngestionCycle(options: IngestionCycleOptions): Promise<IngestionCycleResult> {
  const latestCursor = await options.fillStore.getLatestFillCursor();
  const recentFills = await options.fillSource.listRecentFills(latestCursor);

  let inserted = 0;
  for (const fill of recentFills) {
    if (await options.fillStore.insertFill(fill)) {
      inserted += 1;
    }
  }

  const replayed = await schedulePendingFills(
    options.fillStore,
    options.analysisQueue,
    options.replayLimit ?? DEFAULT_REPLAY_LIMIT,
  );

  const latestFetchedTimestamp = recentFills.length > 0 ? recentFills[recentFills.length - 1]?.timestamp ?? null : null;
  const checkpoint = latestFetchedTimestamp ?? latestCursor?.timestamp ?? null;

  return {
    checkpoint: checkpoint?.toISOString() ?? null,
    fetched: recentFills.length,
    inserted,
    replayed,
  };
}

export async function runStartCommand(options: StartCommandOptions = {}): Promise<void> {
  const config = await loadAppConfig();
  const logger = createAppLogger(config, {
    component: 'engine',
  });
  const pool = createDbPool(config);
  // M3 shared feed: separate database (FEED_DATABASE_URL); omen never reads it back. Disabled => null.
  const feedPool = config.feed.enabled && config.feed.databaseUrl ? new PgPool({ connectionString: config.feed.databaseUrl, max: 2 }) : null;
  const feed = feedPool ? new FeedClient(feedPool) : null;
  // M4: X context through the shared bridge. Requests are only queued while x.source = grokbot.
  const xBridge = feedPool && config.feed.xEnrich ? new XBridge(feedPool, loadXOptions()) : null;
  if (feed) {
    await feed.ensureSchema();
  }
  const redis = createRedisClient(config);
  const alertStore = createAlertStore(pool);
  const fillStore = createFillStore(pool);
  const quarantineStore = createIngestQuarantineStore(pool);
  const marketCatalog = new ActiveMarketCatalog();
  const alertDispatcher = new AlertDispatcher(config, redis);
  let dashboard: TerminalDashboard | null = null;
  const fillSource = createPolymarketFillSource(config.ingestion.maxPagesPerPoll, {
    onInvalidTrade: async (observation) => {
      try {
        await quarantineStore.recordFailure({
          source: observation.source,
          rawPayload: observation.rawPayload,
          failureReason: observation.failureReason,
        });
      } catch (error) {
        reportOperatorError({
          message: `[ingest-quarantine] failed to persist malformed ${observation.source} trade: ${formatError(error)}`,
          dashboard,
          logger,
        });
        return;
      }

      if (dashboard === null) {
        emitStructuredLog(logger, {
          type: 'ingest-quarantine',
          source: observation.source,
          failureReason: observation.failureReason,
        });
      }
    },
  });
  const runtimeStatsCollector = new RuntimeStatsCollector();
  const signalPreviewTasks = new Set<Promise<void>>();
  let stopping = false;

  const stopSignal = new AbortController();
  let lastCuDay: string | null = null;
  const stop = (): void => {
    if (stopping) {
      return;
    }

    stopping = true;
    stopSignal.abort();
    dashboard?.beginShutdown('Shutting down...');
  };

  dashboard =
    options.tui === true
      ? new TerminalDashboard({
          dryRun: alertDispatcher.isDryRun(),
          onDryRunToggle: (dryRun) => {
            alertDispatcher.setDryRun(dryRun);
          },
          onQuit: stop,
        })
      : null;
  const coldPathQueue = createFundingGraphRebuildJobQueue(config);
  const coldWorkerSupervisor = new ColdWorkerSupervisor(config, {
    onError: (message) => {
      reportOperatorError({
        message,
        dashboard,
        logger,
      });
    },
    onInfo: (message) => {
      reportOperatorInfo({
        message,
        dashboard,
        logger,
      });
    },
    pipeOutput: options.tui === true,
  });
  const hotWorker = new HotWorkerClient(config, {
    onSignalPreview: (message) => {
      trackPendingTask(
        signalPreviewTasks,
        handleSignalPreview({
          preview: withEffectiveDryRun(message, alertDispatcher.isDryRun()),
          alertStore,
          fillStore,
          alertDispatcher,
          dashboard,
          logger,
          feed: config.feed.publishLiveAlerts ? feed : null,
          x: xBridge ? { bridge: xBridge, db: pool, minTier: config.feed.xMinTier } : null,
        }),
      );
    },
    onWorkerError: (message) => {
      reportOperatorError({
        message: `[hot-worker] ${message}`,
        dashboard,
        logger,
      });
    },
  });

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    dashboard?.start();
    dashboard?.notify('Initializing runtime...');

    await pingRedis(redis);
    dashboard?.notify('Redis ready. Checking persistence schema...');
    await ensurePersistenceSchema(pool);
    dashboard?.notify('Persistence ready. Starting cold worker...');
    coldWorkerSupervisor.start();
    dashboard?.notify('Cold worker started. Restoring pending alerts...');
    await dispatchPendingAlerts({
      alertStore,
      fillStore,
      alertDispatcher,
      marketCatalog,
      dashboard,
      logger,
    });
    dashboard?.notify('Runtime ready.');
    await refreshDashboardCounts(pool, dashboard).catch((error) => {
      reportOperatorError({
        message: `[tui] ${formatError(error)}`,
        dashboard,
        logger,
      });
    });

    const runtimeStatsTimer = setInterval(() => {
      if (stopping) {
        return;
      }

      const hotWorkerSnapshot = hotWorker.getRuntimeSnapshot();
      const hotWorkerMetrics = hotWorker.drainMetrics();
      void coldPathQueue
        .getRuntimeSnapshot()
        .catch((error) => {
          reportOperatorError({
            message: `[cold-path] ${formatError(error)}`,
            dashboard,
            logger,
          });
          return null;
        })
        .then((coldPathSnapshot) => {
          const runtimeStats = runtimeStatsCollector.buildLog(
            hotWorkerSnapshot,
            hotWorkerMetrics,
            new Date(),
            coldPathSnapshot,
          );
          if (dashboard) {
            dashboard.updateRuntimeStats(runtimeStats);
            void refreshDashboardCounts(pool, dashboard).catch((error) => {
              reportOperatorError({
                message: `[tui] ${formatError(error)}`,
                dashboard,
                logger,
              });
            });
            return;
          }

          void Promise.all([
            readAlchemyCuUsage(redis).catch(() => null),
            readMarketExclusions(redis).catch(() => null),
          ])
            .then(([alchemyCu, marketExcluded]) => {
              emitStructuredLog(logger, { ...runtimeStats, alchemyCu, marketExcluded });
              if (alchemyCu && lastCuDay !== null && alchemyCu.day !== lastCuDay) {
                void readAlchemyCuUsage(redis, new Date(Date.parse(`${lastCuDay}T23:59:59Z`)))
                  .then((previous) => emitStructuredLog(logger, { type: 'alchemy-cu-daily', ...previous }))
                  .catch(() => undefined);
              }
              lastCuDay = alchemyCu?.day ?? lastCuDay;
            });
        });
    }, RUNTIME_STATS_INTERVAL_MS);

    if (typeof runtimeStatsTimer.unref === 'function') {
      runtimeStatsTimer.unref();
    }

    const kalshiClient = new KalshiClient();
    const kalshiGrading = {
      priceAt: (eventTicker: string, ticker: string, at: Date) => kalshiClient.getYesPriceAt(eventTicker, ticker, at),
      settlements: async (tickers: string[]) => {
        const settled: Record<string, number> = {};
        for (const market of await kalshiClient.getMarkets(tickers)) {
          if (market.result === 'yes') settled[market.ticker] = 1;
          else if (market.result === 'no') settled[market.ticker] = 0;
        }
        return settled;
      },
    };
    const kalshiTimers: NodeJS.Timeout[] = [];
    if (config.kalshi.enabled) {
      const kalshi = new KalshiService(kalshiClient, createKalshiStore(pool), {
        ...config.kalshi,
        maxTradePagesPerPoll: 20,
        divergenceCooldownMs: 60 * 60_000,
        bookMoveCooldownMs: 30 * 60_000,
        excludeCategories: config.filters.excludeCategories,
      });
      const loop = (name: string, fn: () => Promise<object>, everyMs: number): void => {
        let running = false;
        const tick = (): void => {
          if (running || stopping) return;
          running = true;
          fn()
            .then((result) => emitStructuredLog(logger, { type: name, ...result }))
            .catch((error: unknown) => reportOperatorError({ message: `[${name}] ${formatError(error)}`, dashboard, logger }))
            .finally(() => {
              running = false;
            });
        };
        const timer = setInterval(tick, everyMs);
        timer.unref?.();
        kalshiTimers.push(timer);
        tick();
      };
      loop('kalshi-trades', () => kalshi.pollTrades(), config.kalshi.tradePollMs);
      loop('kalshi-markets', () => kalshi.runMarketCycle(), config.kalshi.marketCycleMs);
    }

    const outcomeTracker = config.outcomes.enabled
      ? new OutcomeTracker({
          store: createTradeOutcomeStore(pool),
          marketMakers: createMarketMakerStore(pool),
          baselinePerSignal: config.outcomes.baselinePerSignal,
          baselineWindowHours: config.outcomes.baselineWindowHours,
          marketMakerMinScore: config.marketMaker.minScore,
          kalshi: config.kalshi.enabled ? kalshiGrading : undefined,
        })
      : null;
    let outcomeRunning = false;
    const runOutcomeTracker = (): void => {
      if (!outcomeTracker || outcomeRunning || stopping) {
        return;
      }

      outcomeRunning = true;
      // Not awaited on shutdown: an interrupted run is simply redone next start.
      void (
        outcomeTracker
          .runOnce()
          .then(async (result) => {
            const feedSynced = feed && config.feed.syncOutcomes ? await syncOutcomesToFeed(pool, feed, 500, { muteKalshi: config.feed.muteKalshi }) : null;
            emitStructuredLog(logger, { type: 'outcome-tracker', ...result, feedSynced });
          })
          .catch((error) => {
            reportOperatorError({ message: `[outcomes] ${formatError(error)}`, dashboard, logger });
          })
          .finally(() => {
            outcomeRunning = false;
          })
      );
    };
    let xAnnotating = false;
    const runXAnnotator = (): void => {
      if (!xBridge || xAnnotating || stopping) return;
      xAnnotating = true;
      void annotatePendingAlerts(pool, xBridge)
        .then((annotated) => {
          for (const note of annotated) {
            emitStructuredLog(logger, { type: 'x-chatter', ...note });
            dashboard?.annotateAlert(note.fillId, note.summary);
          }
        })
        .catch((error: unknown) => reportOperatorError({ message: `[x] annotate failed: ${formatError(error)}`, dashboard, logger }))
        .finally(() => {
          xAnnotating = false;
        });
    };
    const xTimer = xBridge ? setInterval(runXAnnotator, config.feed.xAnnotateIntervalMs) : null;
    xTimer?.unref?.();

    const outcomeTimer = setInterval(runOutcomeTracker, config.outcomes.intervalMs);
    outcomeTimer.unref?.();
    runOutcomeTracker();

    try {
      while (!stopping) {
        try {
          const result = await runIngestionCycle({
            fillSource,
            fillStore,
            analysisQueue: hotWorker,
          });
          runtimeStatsCollector.recordIngestionCycle(result);
          if (dashboard) {
            dashboard.recordIngestionCycle(result);
            if (result.inserted > 0 || result.replayed > 0) {
              void refreshDashboardCounts(pool, dashboard).catch((error) => {
                reportOperatorError({
                  message: `[tui] ${formatError(error)}`,
                  dashboard,
                  logger,
                });
              });
            }
          } else {
            emitStructuredLog(logger, {
              type: 'ingest-cycle',
              ...result,
            });
          }
        } catch (error) {
          reportOperatorError({
            message: `[ingest] ${formatError(error)}`,
            dashboard,
            logger,
          });
        }

        if (stopping) {
          break;
        }

        await sleepUnlessStopped(config.ingestion.pollIntervalMs, stopSignal.signal);
      }
    } finally {
      clearInterval(runtimeStatsTimer);
      clearInterval(outcomeTimer);
      if (xTimer) clearInterval(xTimer);
      kalshiTimers.forEach((timer) => clearInterval(timer));
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await hotWorker.stop();
    await coldWorkerSupervisor.stop();
    await waitForPendingTasks(signalPreviewTasks);
    await coldPathQueue.close();
    dashboard?.stop();
    redis.disconnect(false);
    await feedPool?.end();
    await pool.end();
  }
}

export async function runReplayCommand(): Promise<number> {
  const config = await loadAppConfig();
  const logger = createAppLogger(config, {
    component: 'replay',
  });
  const pool = createDbPool(config);
  const redis = createRedisClient(config);
  const alertStore = createAlertStore(pool);
  const fillStore = createFillStore(pool);
  const alertDispatcher = new AlertDispatcher(config, redis);
  const marketCatalog = new ActiveMarketCatalog();
  const signalPreviewTasks = new Set<Promise<void>>();
  const hotWorker = new HotWorkerClient(config, {
    onSignalPreview: (message) => {
      trackPendingTask(
        signalPreviewTasks,
        handleSignalPreview({
          preview: withEffectiveDryRun(message, alertDispatcher.isDryRun()),
          alertStore,
          fillStore,
          alertDispatcher,
          dashboard: null,
          logger,
        }),
      );
    },
    onWorkerError: (message) => {
      reportOperatorError({
        message: `[hot-worker] ${message}`,
        dashboard: null,
        logger,
      });
    },
  });
  let replayed = 0;

  try {
    await pingRedis(redis);
    await ensurePersistenceSchema(pool);
    await dispatchPendingAlerts({
      alertStore,
      fillStore,
      alertDispatcher,
      marketCatalog,
      dashboard: null,
      logger,
    });
    replayed = await replayPendingFills(fillStore, hotWorker, DEFAULT_REPLAY_LIMIT);
    emitStructuredLog(logger, {
      type: 'replay',
      replayed,
    });
    return replayed;
  } finally {
    await hotWorker.stop();
    await waitForPendingTasks(signalPreviewTasks);
    redis.disconnect(false);
    await pool.end();
  }
}

export async function runHealthCommand(): Promise<void> {
  const config = await loadAppConfig();
  const report = await collectHealthReport(config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'ok') {
    process.exitCode = 1;
  }
}

export async function replayPendingFills(
  fillStore: FillStore,
  analysisQueue: ReplayAnalysisQueue,
  limit = DEFAULT_REPLAY_LIMIT,
): Promise<number> {
  let replayed = 0;

  while (true) {
    const before = await fillStore.getRuntimeSummary();
    if (before.unanalyzedFillCount === 0) {
      return replayed;
    }

    const queued = await schedulePendingFills(fillStore, analysisQueue, limit);
    if (queued === 0) {
      throw new Error('Replay stalled with unanalyzed fills still remaining');
    }

    replayed += queued;
    await analysisQueue.waitForIdle();

    const after = await fillStore.getRuntimeSummary();
    if (after.unanalyzedFillCount === 0) {
      return replayed;
    }

    if (after.unanalyzedFillCount >= before.unanalyzedFillCount) {
      throw new Error(
        `Replay made no forward progress: ${before.unanalyzedFillCount} unanalyzed fills before processing and ${after.unanalyzedFillCount} after`,
      );
    }
  }
}

async function schedulePendingFills(
  fillStore: FillStore,
  analysisQueue: FillAnalysisQueue,
  limit: number,
): Promise<number> {
  const pendingFills = await fillStore.listUnanalyzedFills(limit);
  let queued = 0;

  for (const fill of pendingFills) {
    const result = await analysisQueue.enqueue(fill);
    if (result === 'accepted') {
      queued += 1;
      continue;
    }

    if (result === 'full') {
      break;
    }
  }

  return queued;
}

async function handleSignalPreview(options: {
  preview: SignalPreview;
  alertStore: AlertStore;
  fillStore: FillStore;
  alertDispatcher: AlertDispatcher;
  dashboard: TerminalDashboard | null;
  logger: Logger;
  feed?: FeedClient | null;
  x?: { bridge: XBridge; db: Pick<Pool, 'query'>; minTier: string } | null;
}): Promise<void> {
  const { preview, alertStore, fillStore, alertDispatcher, dashboard, logger } = options;
  if (dashboard === null) {
    emitStructuredLog(logger, {
      type: 'signal-preview',
      ...preview,
    });
  }

  const promotedAlert = promoteSignalPreview(preview);
  if (!promotedAlert) {
    dashboard?.addSignalPreview(preview);
    return;
  }

  const storedAlert = await resolveStoredAlert(promotedAlert, alertStore, alertDispatcher);
  // Shadow-mode and score-only signals are stored (above) and graded via trade_outcomes (the outcome sync mirrors them
  // to the feed with deliver=false), but never published as a live alert, X-enriched or dispatched.
  if (!isSignalDeliverable(preview.signal)) {
    dashboard?.addSignalPreview(preview);
    return;
  }
  if (options.feed) {
    // The feed owns delivery (dry run unless the feed process is explicitly live); a feed outage never blocks omen.
    try {
      await options.feed.publish(liveAlertEnvelope(storedAlert));
    } catch (error) {
      reportOperatorError({ message: `[feed] publish failed: ${formatError(error)}`, dashboard, logger });
    }
  }
  if (options.x) {
    const request = xRequestForAlert(storedAlert, options.x.minTier);
    if (request) {
      try {
        if ((await options.x.bridge.getSource()) === 'grokbot') {
          const queued = await options.x.bridge.enqueue(request);
          await recordXRequest(options.x.db, storedAlert.fillId, queued.requestId, request.query, queued.status);
          emitStructuredLog(logger, { type: 'x-request', fillId: storedAlert.fillId, query: request.query, ...queued });
        }
      } catch (error) {
        reportOperatorError({ message: `[x] enqueue failed: ${formatError(error)}`, dashboard, logger });
      }
    }
  }
  const presentableAlert = await enrichAlertWithLinkedTradeContext(storedAlert, fillStore);
  dashboard?.addAlert(presentableAlert);

  try {
    const result = await alertDispatcher.dispatch(presentableAlert);
    await alertStore.recordDispatchResult(storedAlert.id, result);
    if (dashboard === null) {
      emitStructuredLog(logger, buildAlertDispatchLog(storedAlert, result, preview.dryRun));
    }
    if (result.failedChannels.length > 0) {
      reportOperatorError({
        message: `[alerts] failed to dispatch on channel(s): ${result.failedChannels.join(', ')}`,
        dashboard,
        logger,
      });
    }
    if (dashboard && result.status === 'suppressed-dry-run') {
      dashboard.notify('Promoted alert kept local because dry-run is enabled');
    }
  } catch (error) {
    reportOperatorError({
      message: `[alerts] ${formatError(error)}`,
      dashboard,
      logger,
    });
  }
}

function withEffectiveDryRun(
  message: SignalPreviewMessage,
  dryRun: boolean,
): SignalPreview {
  const { type: _type, dryRun: _workerDryRun, ...payload } = message;
  return {
    ...payload,
    dryRun,
  };
}

async function refreshDashboardCounts(
  pool: Pick<Pool, 'query'>,
  dashboard: TerminalDashboard | null,
): Promise<void> {
  if (dashboard === null) {
    return;
  }

  const [marketCountResult, walletCountResult] = await Promise.all([
    pool.query<{ count: string }>('select count(distinct market_id)::text as count from fills'),
    pool.query<{ count: string }>('select count(*)::text as count from wallets'),
  ]);

  dashboard.updateCounts({
    marketCount: Number(marketCountResult.rows[0]?.count ?? '0'),
    walletCount: Number(walletCountResult.rows[0]?.count ?? '0'),
  });
}

function reportOperatorError(options: {
  message: string;
  dashboard: TerminalDashboard | null;
  logger: Logger;
}): void {
  if (options.dashboard) {
    options.dashboard.notify(options.message);
    return;
  }

  options.logger.error({
    type: 'operator-log',
    level: 'error',
    message: options.message,
  });
}

function reportOperatorInfo(options: {
  message: string;
  dashboard: TerminalDashboard | null;
  logger: Logger;
}): void {
  if (options.dashboard) {
    options.dashboard.notify(options.message);
    return;
  }

  options.logger.info({
    type: 'operator-log',
    level: 'info',
    message: options.message,
  });
}
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function buildAlertDispatchLog(
  alert: StoredAlert,
  result: AlertDispatchResult,
  dryRun: boolean,
): {
  type: 'alert-dispatch';
  alertId: string;
  fillId: string;
  walletAddress: string;
  marketId: string;
  signalId: PromotedAlert['signal']['signalId'];
  walletLiveTier: PromotedAlert['walletLiveTier'];
  deliveryTier: PromotedAlert['deliveryTier'];
  result: AlertDispatchResult['status'];
  channels: AlertDispatchResult['channels'];
  failedChannels: AlertDispatchResult['failedChannels'];
  dryRun: boolean;
} {
  return {
    type: 'alert-dispatch',
    alertId: alert.id,
    fillId: alert.fillId,
    walletAddress: alert.walletAddress,
    marketId: alert.marketId,
    signalId: alert.signal.signalId,
    walletLiveTier: alert.walletLiveTier,
    deliveryTier: alert.deliveryTier,
    result: result.status,
    channels: result.channels,
    failedChannels: result.failedChannels,
    dryRun,
  };
}

function trackPendingTask(pending: Set<Promise<void>>, task: Promise<void>): void {
  pending.add(task);
  task.finally(() => {
    pending.delete(task);
  });
}

async function waitForPendingTasks(pending: Set<Promise<void>>): Promise<void> {
  if (pending.size === 0) {
    return;
  }

  await Promise.allSettled([...pending]);
}

async function dispatchPendingAlerts(options: {
  alertStore: AlertStore;
  fillStore: FillStore;
  alertDispatcher: AlertDispatcher;
  marketCatalog: ActiveMarketCatalog;
  dashboard: TerminalDashboard | null;
  logger: Logger;
}): Promise<void> {
  while (true) {
    const pendingAlerts = await options.alertStore.listPendingDispatchAlerts(DEFAULT_PENDING_ALERT_BATCH_LIMIT);
    const candidates = pendingAlerts.filter((alert) => {
      const enabledChannels = options.alertDispatcher.getEnabledChannels(alert.deliveryTier);
      if (enabledChannels.length === 0) {
        return false;
      }

      return enabledChannels.some((channel) => !alert.deliveredChannels.includes(channel));
    });

    if (candidates.length === 0) {
      return;
    }

    let madeTerminalProgress = false;
    for (const alert of candidates) {
      const alertWithFreshMarketUrl = await refreshAlertMarketUrl(
        alert,
        options.alertStore,
        options.marketCatalog,
      );
      const presentableAlert = await enrichAlertWithLinkedTradeContext(alertWithFreshMarketUrl, options.fillStore);
      options.dashboard?.addAlert(presentableAlert);
      const missingChannels = options.alertDispatcher
        .getEnabledChannels(presentableAlert.deliveryTier)
        .filter((channel) => !presentableAlert.deliveredChannels.includes(channel));
      try {
        const result = await options.alertDispatcher.dispatch(presentableAlert, { channels: missingChannels });
        await options.alertStore.recordDispatchResult(presentableAlert.id, result);
        if (
          result.channelResults.some(
            (channelResult) =>
              channelResult.status === 'sent' || channelResult.status === 'suppressed-duplicate',
          )
        ) {
          madeTerminalProgress = true;
        }
        if (options.dashboard === null) {
          emitStructuredLog(
            options.logger,
            buildAlertDispatchLog(presentableAlert, result, presentableAlert.dryRun),
          );
        }
        if (result.failedChannels.length > 0) {
          reportOperatorError({
            message: `[alerts] failed to dispatch on channel(s): ${result.failedChannels.join(', ')}`,
            dashboard: options.dashboard,
            logger: options.logger,
          });
        }
      } catch (error) {
        reportOperatorError({
          message: `[alerts] ${formatError(error)}`,
          dashboard: options.dashboard,
          logger: options.logger,
        });
      }
    }

    if (!madeTerminalProgress || pendingAlerts.length < DEFAULT_PENDING_ALERT_BATCH_LIMIT) {
      return;
    }
  }
}

async function resolveStoredAlert(
  promotedAlert: PromotedAlert,
  alertStore: AlertStore,
  alertDispatcher: AlertDispatcher,
): Promise<StoredAlert> {
  const storedAlert = await alertStore.upsertPromotedAlert(
    promotedAlert,
    !promotedAlert.dryRun && isSignalDeliverable(promotedAlert.signal) && alertDispatcher.getEnabledChannels(promotedAlert.deliveryTier).length > 0,
  );

  return {
    ...storedAlert,
    marketUrl: promotedAlert.marketUrl ?? storedAlert.marketUrl,
    fillSide: storedAlert.fillSide,
    fillOutcome: storedAlert.fillOutcome,
    fillPrice: promotedAlert.fillPrice ?? storedAlert.fillPrice,
    fillSizeUsd: promotedAlert.fillSizeUsd ?? storedAlert.fillSizeUsd,
    fillTimestamp: promotedAlert.fillTimestamp ?? storedAlert.fillTimestamp,
  };
}

async function refreshAlertMarketUrl(
  alert: PendingStoredAlert,
  alertStore: AlertStore,
  marketCatalog: ActiveMarketCatalog,
): Promise<PendingStoredAlert> {
  const market = await marketCatalog.getMarket(alert.marketId);
  if (market === null) {
    return alert;
  }

  const marketUrl = buildPolymarketMarketUrl(market.eventSlug, market.marketSlug);
  if (!marketUrl || marketUrl === alert.marketUrl) {
    return alert;
  }

  await alertStore.updateMarketUrl(alert.id, marketUrl);

  return {
    ...alert,
    marketUrl,
  };
}

async function sleepUnlessStopped(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
