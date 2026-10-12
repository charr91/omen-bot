import { Worker } from 'node:worker_threads';
import type { AppConfig } from '../config/schema.js';
import type { FillRecord } from '../types/fill.js';
import type { SignalId } from '../types/signal.js';
import type { EnqueueFillResult, HotWorkerToMainMessage } from '../types/thread-messages.js';

interface HotWorkerClientOptions {
  onSignalPreview?: (message: Extract<HotWorkerToMainMessage, { type: 'SIGNAL_PREVIEW' }>) => void;
  onWorkerError?: (message: string) => void;
}

interface IdleWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface EnqueueWaiter {
  resolve: (result: EnqueueFillResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const ENQUEUE_TIMEOUT_MS = 10_000;

export interface HotWorkerMetricsSnapshot {
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

export class HotWorkerClient {
  private readonly worker: Worker;
  private readonly pendingFillIds = new Set<string>();
  private readonly idleWaiters = new Set<IdleWaiter>();
  private readonly enqueueWaiters = new Map<string, EnqueueWaiter>();
  private readonly onSignalPreview?: HotWorkerClientOptions['onSignalPreview'];
  private readonly onWorkerError?: HotWorkerClientOptions['onWorkerError'];
  private queueDepth = 0;
  private processing = false;
  private lastHeartbeatAt: string | null = null;
  private lastProcessedAt: string | null = null;
  private stopping = false;
  private workerError: Error | null = null;
  private readonly exitPromise: Promise<number>;
  private metrics: HotWorkerMetricsSnapshot = {
    enqueueAccepted: 0,
    enqueueDuplicate: 0,
    enqueueFull: 0,
    processed: 0,
    failed: 0,
    signalPreviewCountsBySignalId: {},
  };

  constructor(config: AppConfig, options: HotWorkerClientOptions = {}) {
    if (!config.alchemyApiKey && !(process.env.OMEN_ALLOW_MISSING_ALCHEMY === 'true')) {
      throw new Error('ALCHEMY_API_KEY is required to start the hot worker (set OMEN_ALLOW_MISSING_ALCHEMY=true for degraded no-Alchemy mode)');
    }

    this.onSignalPreview = options.onSignalPreview;
    this.onWorkerError = options.onWorkerError;
    this.worker = new Worker(buildWorkerBootstrapSource(), {
      eval: true,
      workerData: {
        config,
        runtimeUrl: resolveWorkerRuntimeUrl().href,
      },
      stdin: false,
      stdout: false,
      stderr: false,
    });
    this.worker.on('message', (message: HotWorkerToMainMessage) => {
      this.handleMessage(message);
    });
    this.worker.on('error', (error) => {
      this.recordWorkerError(error instanceof Error ? error : new Error(String(error)));
    });

    this.exitPromise = new Promise((resolve) => {
      this.worker.once('exit', (code) => {
        if (!this.stopping && code !== 0) {
          this.recordWorkerError(new Error(`Hot worker exited with code ${code}`));
        }
        resolve(code);
      });
    });
  }

  async enqueue(fill: FillRecord): Promise<EnqueueFillResult> {
    this.assertHealthy();
    if (this.pendingFillIds.has(fill.id)) {
      this.metrics.enqueueDuplicate += 1;
      return 'duplicate';
    }

    this.pendingFillIds.add(fill.id);
    const resultPromise = new Promise<EnqueueFillResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.enqueueWaiters.delete(fill.id);
        this.pendingFillIds.delete(fill.id);
        reject(new Error(`Timed out waiting for hot-worker enqueue ack for fill ${fill.id}`));
      }, ENQUEUE_TIMEOUT_MS);
      this.enqueueWaiters.set(fill.id, {
        resolve,
        reject,
        timer,
      });
    });
    this.worker.postMessage({
      type: 'ANALYZE_FILL',
      fill,
    });
    return resultPromise;
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    this.assertHealthy();
    if (this.isIdle()) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              this.idleWaiters.delete(waiter);
              reject(new Error('Timed out waiting for the hot worker to become idle'));
            }, timeoutMs);
      const waiter: IdleWaiter = {
        resolve: () => {
          if (timer) {
            clearTimeout(timer);
          }
          resolve();
        },
        reject: (error) => {
          if (timer) {
            clearTimeout(timer);
          }
          reject(error);
        },
        timer,
      };
      this.idleWaiters.add(waiter);
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await this.exitPromise;
      return;
    }

    this.stopping = true;
    this.worker.postMessage({
      type: 'STOP',
    });

    const code = await Promise.race([
      this.exitPromise,
      new Promise<number>((resolve) => {
        setTimeout(() => resolve(-1), 10_000);
      }),
    ]);

    if (code === -1) {
      await this.worker.terminate();
    }
  }

  getLastHeartbeatAt(): string | null {
    return this.lastHeartbeatAt;
  }

  getRuntimeSnapshot(): HotWorkerRuntimeSnapshot {
    return {
      queueDepth: this.queueDepth,
      pendingFillCount: this.pendingFillIds.size,
      processing: this.processing,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastProcessedAt: this.lastProcessedAt,
    };
  }

  drainMetrics(): HotWorkerMetricsSnapshot {
    const snapshot: HotWorkerMetricsSnapshot = {
      enqueueAccepted: this.metrics.enqueueAccepted,
      enqueueDuplicate: this.metrics.enqueueDuplicate,
      enqueueFull: this.metrics.enqueueFull,
      processed: this.metrics.processed,
      failed: this.metrics.failed,
      signalPreviewCountsBySignalId: { ...this.metrics.signalPreviewCountsBySignalId },
    };

    this.metrics = {
      enqueueAccepted: 0,
      enqueueDuplicate: 0,
      enqueueFull: 0,
      processed: 0,
      failed: 0,
      signalPreviewCountsBySignalId: {},
    };

    return snapshot;
  }

  private handleMessage(message: HotWorkerToMainMessage): void {
    if (message.type === 'HEARTBEAT') {
      this.queueDepth = message.queueDepth;
      this.processing = message.processing;
      this.lastHeartbeatAt = message.at;
      this.lastProcessedAt = message.lastProcessedAt;
      this.resolveIdleWaitersIfNeeded();
      return;
    }

    if (message.type === 'ENQUEUE_RESULT') {
      const waiter = this.enqueueWaiters.get(message.fillId);
      if (!waiter) {
        return;
      }

      clearTimeout(waiter.timer);
      this.enqueueWaiters.delete(message.fillId);
      if (message.result !== 'accepted') {
        this.pendingFillIds.delete(message.fillId);
      }
      if (message.result === 'accepted') {
        this.metrics.enqueueAccepted += 1;
      } else if (message.result === 'duplicate') {
        this.metrics.enqueueDuplicate += 1;
      } else {
        this.metrics.enqueueFull += 1;
      }
      waiter.resolve(message.result);
      this.resolveIdleWaitersIfNeeded();
      return;
    }

    if (message.type === 'FILL_RESULT') {
      this.pendingFillIds.delete(message.fillId);
      if (message.status === 'processed') {
        this.metrics.processed += 1;
      } else {
        this.metrics.failed += 1;
      }
      if (message.status !== 'processed' && message.error) {
        this.onWorkerError?.(`[fill ${message.fillId}] ${message.error}`);
      }
      this.resolveIdleWaitersIfNeeded();
      return;
    }

    if (message.type === 'SIGNAL_PREVIEW') {
      this.metrics.signalPreviewCountsBySignalId[message.signal.signalId] =
        (this.metrics.signalPreviewCountsBySignalId[message.signal.signalId] ?? 0) + 1;
      this.onSignalPreview?.(message);
      return;
    }

    if (message.type === 'ERROR') {
      this.onWorkerError?.(message.fillId ? `[fill ${message.fillId}] ${message.error}` : message.error);
    }
  }

  private isIdle(): boolean {
    return this.pendingFillIds.size === 0 && this.queueDepth === 0 && !this.processing;
  }

  private resolveIdleWaitersIfNeeded(): void {
    if (!this.isIdle()) {
      return;
    }

    for (const waiter of this.idleWaiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve();
    }
    this.idleWaiters.clear();
  }

  private recordWorkerError(error: Error): void {
    this.workerError = error;
    this.onWorkerError?.(error.message);
    for (const waiter of this.enqueueWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.enqueueWaiters.clear();
    for (const waiter of this.idleWaiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.reject(error);
    }
    this.idleWaiters.clear();
  }

  private assertHealthy(): void {
    if (this.workerError) {
      throw this.workerError;
    }
  }
}

function resolveWorkerRuntimeUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './runtime.ts' : './runtime.js', import.meta.url);
}

function buildWorkerBootstrapSource(): string {
  return `
const { workerData } = require('node:worker_threads');

(async () => {
  if (workerData.runtimeUrl.endsWith('.ts')) {
    const { register } = await import('tsx/esm/api');
    register();
  }

  await import(workerData.runtimeUrl);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}
