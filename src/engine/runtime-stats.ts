import type { SignalId } from '../types/signal.js';

const DEFAULT_WINDOW_SECONDS = 60;

export interface HotWorkerMetrics {
  enqueueAccepted: number;
  enqueueDuplicate: number;
  enqueueFull: number;
  processed: number;
  failed: number;
  signalPreviewCountsBySignalId: Partial<Record<SignalId, number>>;
}

export interface HotWorkerRuntimeSnapshot {
  queueDepth: number;
  pendingFillCount: number;
  processing: boolean;
  lastHeartbeatAt: string | null;
  lastProcessedAt: string | null;
}

export interface RuntimeStatsLog {
  type: 'runtime-stats';
  collectedAt: string;
  windowSeconds: number;
  ingest: {
    cycles: number;
    fetched: number;
    inserted: number;
    replayAccepted: number;
  };
  hotWorker: {
    enqueueAccepted: number;
    enqueueDuplicate: number;
    enqueueFull: number;
    processed: number;
    failed: number;
    queueDepth: number;
    pendingFillCount: number;
    processing: boolean;
    lastHeartbeatAt: string | null;
    lastProcessedAt: string | null;
    lastProcessedAgeMs: number | null;
  };
  signals: {
    previewCountsBySignalId: Partial<Record<SignalId, number>>;
  };
}

export class RuntimeStatsCollector {
  private cycles = 0;
  private fetched = 0;
  private inserted = 0;
  private replayAccepted = 0;

  recordIngestionCycle(result: { fetched: number; inserted: number; replayed: number }): void {
    this.cycles += 1;
    this.fetched += result.fetched;
    this.inserted += result.inserted;
    this.replayAccepted += result.replayed;
  }

  buildLog(
    hotWorkerSnapshot: HotWorkerRuntimeSnapshot,
    hotWorkerMetrics: HotWorkerMetrics,
    collectedAt = new Date(),
  ): RuntimeStatsLog {
    const collectedAtIso = collectedAt.toISOString();
    const lastProcessedAt = hotWorkerSnapshot.lastProcessedAt;
    const lastProcessedAtMs = lastProcessedAt ? Date.parse(lastProcessedAt) : Number.NaN;

    const log: RuntimeStatsLog = {
      type: 'runtime-stats',
      collectedAt: collectedAtIso,
      windowSeconds: DEFAULT_WINDOW_SECONDS,
      ingest: {
        cycles: this.cycles,
        fetched: this.fetched,
        inserted: this.inserted,
        replayAccepted: this.replayAccepted,
      },
      hotWorker: {
        enqueueAccepted: hotWorkerMetrics.enqueueAccepted,
        enqueueDuplicate: hotWorkerMetrics.enqueueDuplicate,
        enqueueFull: hotWorkerMetrics.enqueueFull,
        processed: hotWorkerMetrics.processed,
        failed: hotWorkerMetrics.failed,
        queueDepth: hotWorkerSnapshot.queueDepth,
        pendingFillCount: hotWorkerSnapshot.pendingFillCount,
        processing: hotWorkerSnapshot.processing,
        lastHeartbeatAt: hotWorkerSnapshot.lastHeartbeatAt,
        lastProcessedAt,
        lastProcessedAgeMs:
          Number.isFinite(lastProcessedAtMs) ? collectedAt.getTime() - lastProcessedAtMs : null,
      },
      signals: {
        previewCountsBySignalId: { ...hotWorkerMetrics.signalPreviewCountsBySignalId },
      },
    };

    this.cycles = 0;
    this.fetched = 0;
    this.inserted = 0;
    this.replayAccepted = 0;

    return log;
  }
}
