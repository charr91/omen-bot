import { emitKeypressEvents } from 'node:readline';
import type { IngestionCycleResult } from '../engine/index.js';
import type { RuntimeStatsLog } from '../engine/runtime-stats.js';
import type { PresentableAlert, SignalPreview } from '../types/alert.js';
import { renderDashboard, type AlertFeedFilter } from './render.js';

interface TerminalDashboardOptions {
  dryRun: boolean;
  onDryRunToggle?: (dryRun: boolean) => void;
  onQuit?: () => void;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

interface DashboardCounts {
  marketCount: number | null;
  walletCount: number | null;
}

export class TerminalDashboard {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly onDryRunToggle?: (dryRun: boolean) => void;
  private readonly onQuit?: () => void;
  private readonly alerts: PresentableAlert[] = [];
  private readonly signalPreviews: SignalPreview[] = [];
  private dryRun: boolean;
  private tierFilter: AlertFeedFilter = 'ALL';
  private helpVisible = false;
  private lastCheckpoint: string | null = null;
  private lastStatusMessage: string | null = null;
  private marketCount: number | null = null;
  private walletCount: number | null = null;
  private runtimeStats: RuntimeStatsLog | null = null;
  private shuttingDown = false;
  private shutdownMessage: string | null = null;
  private started = false;

  constructor(options: TerminalDashboardOptions) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.dryRun = options.dryRun;
    this.onDryRunToggle = options.onDryRunToggle;
    this.onQuit = options.onQuit;
  }

  start(): void {
    if (this.started) {
      return;
    }

    if (!this.stdin.isTTY || !this.stdout.isTTY || typeof this.stdin.setRawMode !== 'function') {
      throw new Error('start --tui requires an interactive TTY');
    }

    this.started = true;
    emitKeypressEvents(this.stdin);
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('keypress', this.handleKeypress);
    this.stdout.on('resize', this.render);
    this.stdout.write('\x1b[?25l');
    this.render();
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.stdin.off('keypress', this.handleKeypress);
    this.stdout.off('resize', this.render);
    if (typeof this.stdin.setRawMode === 'function') {
      this.stdin.setRawMode(false);
    }
    this.stdin.pause();
    this.stdout.write('\x1b[0m\x1b[?25h\n');
  }

  addAlert(alert: PresentableAlert): void {
    this.alerts.unshift(alert);
    if (this.alerts.length > 100) {
      this.alerts.length = 100;
    }
    this.render();
  }

  addSignalPreview(preview: SignalPreview): void {
    this.signalPreviews.unshift(preview);
    if (this.signalPreviews.length > 100) {
      this.signalPreviews.length = 100;
    }
    this.render();
  }

  recordIngestionCycle(result: IngestionCycleResult): void {
    this.lastCheckpoint = result.checkpoint;
    this.render();
  }

  updateRuntimeStats(runtimeStats: RuntimeStatsLog): void {
    this.runtimeStats = runtimeStats;
    this.render();
  }

  updateCounts(counts: DashboardCounts): void {
    this.marketCount = counts.marketCount;
    this.walletCount = counts.walletCount;
    this.render();
  }

  notify(message: string): void {
    this.lastStatusMessage = message;
    this.render();
  }

  beginShutdown(message = 'Shutting down...'): void {
    this.shuttingDown = true;
    this.shutdownMessage = message;
    this.render();
  }

  private readonly handleKeypress = (_value: string, key: { ctrl?: boolean; name?: string }): void => {
    if (key.ctrl && key.name === 'c') {
      this.requestQuit();
      return;
    }

    if (key.name === 'q') {
      this.requestQuit();
      return;
    }

    if (this.shuttingDown) {
      return;
    }

    if (key.name === '?') {
      this.helpVisible = !this.helpVisible;
      this.render();
      return;
    }

    if (key.name === 't') {
      this.tierFilter = cycleTierFilter(this.tierFilter);
      this.render();
      return;
    }

    if (key.name === 'd') {
      this.dryRun = !this.dryRun;
      this.onDryRunToggle?.(this.dryRun);
      this.lastStatusMessage = `External alert dry-run ${this.dryRun ? 'enabled' : 'disabled'}`;
      this.render();
      return;
    }

    if (key.name === 'escape') {
      this.helpVisible = false;
      this.tierFilter = 'ALL';
      this.lastStatusMessage = null;
      this.render();
    }
  };

  private readonly render = (): void => {
    if (!this.started) {
      return;
    }

    const output = renderDashboard({
      width: this.stdout.columns ?? 100,
      height: this.stdout.rows ?? 24,
      alerts: this.alerts,
      signalPreviews: this.signalPreviews,
      tierFilter: this.tierFilter,
      dryRun: this.dryRun,
      helpVisible: this.helpVisible,
      lastCheckpoint: this.lastCheckpoint,
      lastStatusMessage: this.lastStatusMessage,
      marketCount: this.marketCount,
      walletCount: this.walletCount,
      runtimeStats: this.runtimeStats,
      shuttingDown: this.shuttingDown,
      shutdownMessage: this.shutdownMessage,
    });

    this.stdout.write(`\x1b[2J\x1b[H${output}`);
  };

  private requestQuit(): void {
    if (this.shuttingDown) {
      return;
    }

    this.beginShutdown();
    this.onQuit?.();
  }
}

function cycleTierFilter(current: AlertFeedFilter): AlertFeedFilter {
  switch (current) {
    case 'ALL':
      return 'CRITICAL';
    case 'CRITICAL':
      return 'HIGH';
    case 'HIGH':
      return 'MEDIUM';
    case 'MEDIUM':
      return 'LOW';
    default:
      return 'ALL';
  }
}
