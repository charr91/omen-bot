import type { Pool } from 'pg';
import { AlertDispatcher } from '../alerts/dispatcher.js';
import { promoteSignalPreview } from '../alerts/promote.js';
import { loadAppConfig } from '../config/index.js';
import { RuntimeStatsCollector } from './runtime-stats.js';
import { HotWorkerClient } from '../hot-worker/client.js';
import { createPolymarketFillSource, type FillSource } from '../ingestion/polymarket-client.js';
import { sleep } from '../phase0/io.js';
import { createDbPool } from '../persistence/db.js';
import { createAlertStore, type AlertStore } from '../persistence/queries/alerts.js';
import { createFillStore, type FillStore } from '../persistence/queries/fills.js';
import { createRedisClient, pingRedis } from '../persistence/redis.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { collectHealthReport } from '../resilience/health.js';
import { TerminalDashboard } from '../tui/dashboard.js';
import type { PromotedAlert, SignalPreview, StoredAlert } from '../types/alert.js';
import type { FillRecord } from '../types/fill.js';
import type { EnqueueFillResult, HotWorkerToMainMessage } from '../types/thread-messages.js';
import type { AlertDispatchResult } from '../alerts/channel.js';

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
  const pool = createDbPool(config);
  const redis = createRedisClient(config);
  const alertStore = createAlertStore(pool);
  const fillStore = createFillStore(pool);
  const fillSource = createPolymarketFillSource(config.ingestion.maxPagesPerPoll);
  const runtimeStatsCollector = new RuntimeStatsCollector();
  const signalPreviewTasks = new Set<Promise<void>>();
  let stopping = false;

  const stop = (): void => {
    stopping = true;
  };

  const alertDispatcher = new AlertDispatcher(config, redis);
  const dashboard =
    options.tui === true
      ? new TerminalDashboard({
          dryRun: alertDispatcher.isDryRun(),
          onDryRunToggle: (dryRun) => {
            alertDispatcher.setDryRun(dryRun);
          },
          onQuit: stop,
        })
      : null;
  const hotWorker = new HotWorkerClient(config, {
    onSignalPreview: (message) => {
      trackSignalPreviewTask(
        signalPreviewTasks,
        handleSignalPreview({
          preview: withEffectiveDryRun(message, alertDispatcher.isDryRun()),
          alertStore,
          alertDispatcher,
          dashboard,
        }),
      );
    },
    onWorkerError: (message) => {
      reportOperatorError({
        message: `[hot-worker] ${message}`,
        dashboard,
      });
    },
  });

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await pingRedis(redis);
    await ensurePersistenceSchema(pool);
    dashboard?.start();
    await dispatchPendingAlerts({
      alertStore,
      alertDispatcher,
      dashboard,
    });
    await refreshDashboardCounts(pool, dashboard).catch((error) => {
      reportOperatorError({
        message: `[tui] ${formatError(error)}`,
        dashboard,
      });
    });

    const runtimeStatsTimer = setInterval(() => {
      if (stopping) {
        return;
      }

      const runtimeStats = runtimeStatsCollector.buildLog(
        hotWorker.getRuntimeSnapshot(),
        hotWorker.drainMetrics(),
      );
      if (dashboard) {
        dashboard.updateRuntimeStats(runtimeStats);
        void refreshDashboardCounts(pool, dashboard).catch((error) => {
          reportOperatorError({
            message: `[tui] ${formatError(error)}`,
            dashboard,
          });
        });
        return;
      }

      process.stdout.write(`${JSON.stringify(runtimeStats)}\n`);
    }, RUNTIME_STATS_INTERVAL_MS);

    if (typeof runtimeStatsTimer.unref === 'function') {
      runtimeStatsTimer.unref();
    }

    try {
      while (!stopping) {
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
              });
            });
          }
        } else {
          process.stdout.write(`${JSON.stringify({ type: 'ingest-cycle', ...result })}\n`);
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
    await waitForSignalPreviewTasks(signalPreviewTasks);
    dashboard?.stop();
    redis.disconnect(false);
    await pool.end();
  }
}

export async function runReplayCommand(): Promise<number> {
  const config = await loadAppConfig();
  const pool = createDbPool(config);
  const redis = createRedisClient(config);
  const alertStore = createAlertStore(pool);
  const fillStore = createFillStore(pool);
  const alertDispatcher = new AlertDispatcher(config, redis);
  const signalPreviewTasks = new Set<Promise<void>>();
  const hotWorker = new HotWorkerClient(config, {
    onSignalPreview: (message) => {
      trackSignalPreviewTask(
        signalPreviewTasks,
        handleSignalPreview({
          preview: withEffectiveDryRun(message, alertDispatcher.isDryRun()),
          alertStore,
          alertDispatcher,
          dashboard: null,
        }),
      );
    },
    onWorkerError: (message) => {
      process.stderr.write(`[hot-worker] ${message}\n`);
    },
  });
  let replayed = 0;

  try {
    await pingRedis(redis);
    await ensurePersistenceSchema(pool);
    await dispatchPendingAlerts({
      alertStore,
      alertDispatcher,
      dashboard: null,
    });
    replayed = await replayPendingFills(fillStore, hotWorker, DEFAULT_REPLAY_LIMIT);

    process.stdout.write(`${JSON.stringify({ type: 'replay', replayed })}\n`);
    return replayed;
  } finally {
    await hotWorker.stop();
    await waitForSignalPreviewTasks(signalPreviewTasks);
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
  alertDispatcher: AlertDispatcher;
  dashboard: TerminalDashboard | null;
}): Promise<void> {
  const { preview, alertStore, alertDispatcher, dashboard } = options;
  if (dashboard === null) {
    process.stdout.write(`${JSON.stringify({ type: 'signal-preview', ...preview })}\n`);
  }

  const promotedAlert = promoteSignalPreview(preview);
  if (!promotedAlert) {
    return;
  }

  dashboard?.addAlert(promotedAlert);
  const storedAlert = await resolveStoredAlert(promotedAlert, alertStore, alertDispatcher);

  try {
    const result = await alertDispatcher.dispatch(promotedAlert);
    await alertStore.recordDispatchResult(storedAlert.id, result);
    if (dashboard === null) {
      process.stdout.write(`${JSON.stringify(buildAlertDispatchLog(storedAlert, result, preview.dryRun))}\n`);
    }
    if (result.failedChannels.length > 0) {
      reportOperatorError({
        message: `[alerts] failed to dispatch on channel(s): ${result.failedChannels.join(', ')}`,
        dashboard,
      });
    }
    if (dashboard && result.status === 'suppressed-dry-run') {
      dashboard.notify('Promoted alert kept local because dry-run is enabled');
    }
  } catch (error) {
    reportOperatorError({
      message: `[alerts] ${formatError(error)}`,
      dashboard,
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
}): void {
  if (options.dashboard) {
    options.dashboard.notify(options.message);
    return;
  }

  process.stderr.write(`${options.message}\n`);
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

function trackSignalPreviewTask(pending: Set<Promise<void>>, task: Promise<void>): void {
  pending.add(task);
  task.finally(() => {
    pending.delete(task);
  });
}

async function waitForSignalPreviewTasks(pending: Set<Promise<void>>): Promise<void> {
  if (pending.size === 0) {
    return;
  }

  await Promise.allSettled([...pending]);
}

async function dispatchPendingAlerts(options: {
  alertStore: AlertStore;
  alertDispatcher: AlertDispatcher;
  dashboard: TerminalDashboard | null;
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
      options.dashboard?.addAlert(alert);
      const missingChannels = options.alertDispatcher
        .getEnabledChannels(alert.deliveryTier)
        .filter((channel) => !alert.deliveredChannels.includes(channel));
      try {
        const result = await options.alertDispatcher.dispatch(alert, { channels: missingChannels });
        await options.alertStore.recordDispatchResult(alert.id, result);
        if (
          result.channelResults.some(
            (channelResult) =>
              channelResult.status === 'sent' || channelResult.status === 'suppressed-duplicate',
          )
        ) {
          madeTerminalProgress = true;
        }
        if (options.dashboard === null) {
          process.stdout.write(`${JSON.stringify(buildAlertDispatchLog(alert, result, alert.dryRun))}\n`);
        }
        if (result.failedChannels.length > 0) {
          reportOperatorError({
            message: `[alerts] failed to dispatch on channel(s): ${result.failedChannels.join(', ')}`,
            dashboard: options.dashboard,
          });
        }
      } catch (error) {
        reportOperatorError({
          message: `[alerts] ${formatError(error)}`,
          dashboard: options.dashboard,
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
  return alertStore.upsertPromotedAlert(
    promotedAlert,
    !promotedAlert.dryRun && alertDispatcher.getEnabledChannels(promotedAlert.deliveryTier).length > 0,
  );
}
