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
import { sleep } from '../phase0/io.js';
import { RuntimeStatsCollector } from './runtime-stats.js';
import { createDbPool } from '../persistence/db.js';
import { createAlertStore, type AlertStore, type PendingStoredAlert } from '../persistence/queries/alerts.js';
import { createFillStore, type FillStore } from '../persistence/queries/fills.js';
import { createIngestQuarantineStore } from '../persistence/queries/ingest-quarantine.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';
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

  const stop = (): void => {
    if (stopping) {
      return;
    }

    stopping = true;
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

          emitStructuredLog(logger, runtimeStats);
        });
    }, RUNTIME_STATS_INTERVAL_MS);

    if (typeof runtimeStatsTimer.unref === 'function') {
      runtimeStatsTimer.unref();
    }

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

        await sleep(config.ingestion.pollIntervalMs);
      }
    } finally {
      clearInterval(runtimeStatsTimer);
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
    !promotedAlert.dryRun && alertDispatcher.getEnabledChannels(promotedAlert.deliveryTier).length > 0,
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
