import type { RuntimeStatsLog } from '../engine/runtime-stats.js';
import {
  formatAlertFillSize,
  formatAlertMeaning,
  formatAlertScore,
  formatAlertShortWallet,
  formatAlertTradeAction,
  formatLinkedTradeContextCompact,
  getAlertTierAnsiCodes,
} from '../alerts/presentation.js';
import { sanitizeForTerminal } from '../resilience/sanitizer.js';
import type { PresentableAlert, PromotedAlertTier, SignalPreview } from '../types/alert.js';

export type AlertFeedFilter = 'ALL' | PromotedAlertTier;

export interface DashboardRenderState {
  width: number;
  height: number;
  alerts: PresentableAlert[];
  signalPreviews: SignalPreview[];
  tierFilter: AlertFeedFilter;
  dryRun: boolean;
  helpVisible: boolean;
  lastCheckpoint: string | null;
  lastStatusMessage: string | null;
  marketCount: number | null;
  walletCount: number | null;
  runtimeStats: RuntimeStatsLog | null;
  shuttingDown: boolean;
  shutdownMessage: string | null;
}

const DASHBOARD_MIN_WIDTH = 80;
const DASHBOARD_MIN_HEIGHT = 16;

export function renderDashboard(state: DashboardRenderState): string {
  const width = Math.max(state.width, DASHBOARD_MIN_WIDTH);
  const height = Math.max(state.height, DASHBOARD_MIN_HEIGHT);
  const shuttingDown = state.shuttingDown ?? false;
  const shutdownMessage = state.shutdownMessage ?? null;
  const signalPreviews = state.signalPreviews ?? [];

  if (state.helpVisible) {
    return renderHelp(width, state.dryRun, state.tierFilter, shuttingDown, shutdownMessage);
  }

  const filteredAlerts = state.alerts.filter((alert) => {
    if (state.tierFilter === 'ALL') {
      return true;
    }

    return alert.deliveryTier === state.tierFilter;
  });

  const header = padRight('OMEN Phase 1 Dashboard', width);
  const meta = padRight(
    `Signal feed promoted to alerts only at LOW+ | Filter: ${state.tierFilter} | DryRun: ${
      state.dryRun ? 'ON' : 'OFF'
    }`,
    width,
  );
  const divider = '-'.repeat(width);
  const footer = padRight(buildStatusLine(state), width);
  const controls = padRight(
    state.shuttingDown
      ? 'Stopping... waiting for ingest, hot worker, and cold worker to exit'
      : '[q]Quit [?]Help [t]TierFilter [d]DryRun [Esc]Reset',
    width,
  );
  const availableFeedLines = Math.max(height - 5, 4);
  const feedLines = renderFeed({
    alerts: filteredAlerts,
    totalAlertCount: state.alerts.length,
    signalPreviews,
    width,
    maxLines: availableFeedLines,
  });
  const statusMessage = padRight(
    sanitizeForTerminal(shutdownMessage ?? state.lastStatusMessage ?? ''),
    width,
  );

  return [header, meta, divider, ...feedLines, divider, footer, statusMessage, controls]
    .slice(0, height)
    .join('\n');
}

function renderHelp(
  width: number,
  dryRun: boolean,
  tierFilter: AlertFeedFilter,
  shuttingDown: boolean,
  shutdownMessage: string | null,
): string {
  return [
    padRight('OMEN Phase 1 Dashboard Help', width),
    padRight(
      `Current filter: ${tierFilter} | DryRun: ${dryRun ? 'ON' : 'OFF'} | State:${
        shuttingDown ? 'STOPPING' : 'RUNNING'
      }`,
      width,
    ),
    padRight('-'.repeat(width), width),
    padRight(sanitizeForTerminal(shutdownMessage ?? ''), width),
    padRight('q     Quit the dashboard and stop omen start', width),
    padRight('?     Toggle this help overlay', width),
    padRight('t     Cycle alert tier filter (ALL -> CRITICAL -> HIGH -> MEDIUM -> LOW)', width),
    padRight('d     Toggle external-alert dry-run mode for promoted alerts', width),
    padRight('Esc   Reset the filter and close help', width),
    padRight('', width),
    padRight('Signal previews are persisted LIVE signal events.', width),
    padRight('The feed prefers promoted LOW/HIGH/CRITICAL alerts and falls back to recent previews.', width),
  ].join('\n');
}

function renderFeed(options: {
  alerts: PresentableAlert[];
  totalAlertCount: number;
  signalPreviews: SignalPreview[];
  width: number;
  maxLines: number;
}): string[] {
  if (options.alerts.length > 0) {
    return renderAlertFeed(options.alerts, options.width, options.maxLines);
  }

  if (options.totalAlertCount > 0) {
    return [
      padRight('Promoted alerts exist, but none match the current tier filter.', options.width),
      padRight('Press `t` to cycle the filter or `Esc` to reset it to ALL.', options.width),
    ];
  }

  if (options.signalPreviews.length > 0) {
    return renderSignalPreviewFeed(options.signalPreviews, options.width, options.maxLines);
  }

  return [
    padRight('Listening to Polymarket...', options.width),
    padRight('No promoted alerts yet. CLEAN signal events stay out of the alert feed.', options.width),
  ];
}

function renderAlertFeed(alerts: PresentableAlert[], width: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const alert of alerts) {
    const timestamp = formatIsoTime(alert.fillTimestamp ?? alert.promotedAt);
    const meaningLine = formatAlertMeaning(alert);
    lines.push(padRight(`${renderTierChip(alert.deliveryTier)} ${timestamp} ${alert.signal.signalId}`, width));
    lines.push(padRight(truncate(sanitizeForTerminal(alert.marketQuestion), width), width));
    if (meaningLine) {
      lines.push(padRight(truncate(paint(sanitizeForTerminal(meaningLine), ['2', '3']), width), width));
    }
    const contextSuffix = alert.linkedTradeContext
      ? ` | ${sanitizeForTerminal(formatLinkedTradeContextCompact(alert.linkedTradeContext))}`
      : '';
    lines.push(
      padRight(
        truncate(
          `${sanitizeForTerminal(formatAlertTradeAction(alert))} | fill $${sanitizeForTerminal(
            formatAlertFillSize(alert),
          )} | score ${sanitizeForTerminal(formatAlertScore(alert))} | ${sanitizeForTerminal(
            formatAlertShortWallet(alert.walletAddress),
          )}${contextSuffix}`,
          width,
        ),
        width,
      ),
    );
    if (lines.length >= maxLines) {
      break;
    }
  }

  return lines.slice(0, maxLines);
}

function renderSignalPreviewFeed(signalPreviews: SignalPreview[], width: number, maxLines: number): string[] {
  const lines = [padRight('No promoted alerts yet. Recent LIVE signal previews:', width)];

  for (const preview of signalPreviews) {
    const timestamp = formatIsoTime(preview.fillTimestamp ?? preview.signal.triggeredAt);
    lines.push(padRight(renderPreviewTierLine(preview.walletLiveTier, timestamp, preview.signal.signalId), width));
    lines.push(
      padRight(
        truncate(
          `${sanitizeForTerminal(formatAlertTradeAction(preview))} | fill $${sanitizeForTerminal(
            formatAlertFillSize(preview),
          )} | score ${sanitizeForTerminal(formatAlertScore(preview))} | ${sanitizeForTerminal(
            formatAlertShortWallet(preview.walletAddress),
          )}`,
          width,
        ),
        width,
      ),
    );
    lines.push(padRight(truncate(sanitizeForTerminal(preview.marketQuestion), width), width));
    if (lines.length >= maxLines) {
      break;
    }
  }

  return lines.slice(0, maxLines);
}

function buildStatusLine(state: DashboardRenderState): string {
  const hotWorker = state.runtimeStats?.hotWorker ?? null;
  const coldPath = state.runtimeStats?.coldPath ?? null;
  const shuttingDown = state.shuttingDown ?? false;
  const restState = state.lastCheckpoint ? 'UP' : 'WAIT';
  const hotState = hotWorker === null ? 'WAIT' : hotWorker.processing || hotWorker.queueDepth > 0 ? 'BUSY' : 'IDLE';
  const coldState =
    coldPath === null ? 'WAIT' : coldPath.activeCount > 0 || coldPath.waitingCount > 0 ? 'BUSY' : 'IDLE';

  return [
    `State:${shuttingDown ? 'STOPPING' : 'RUNNING'}`,
    `REST:${restState}`,
    `Hot:${hotState}`,
    `Cold:${coldState}`,
    `Mkts:${formatNullableCount(state.marketCount)}`,
    `Wallets:${formatNullableCount(state.walletCount)}`,
    `Alerts:${state.alerts.length}`,
    `Prev60s:${formatSignalPreviewCount(state.runtimeStats)}`,
    `Queue:${hotWorker?.queueDepth ?? 'n/a'}`,
    `ColdQ:${coldPath?.waitingCount ?? 'n/a'}`,
    `Pending:${hotWorker?.pendingFillCount ?? 'n/a'}`,
    `Checkpoint:${state.lastCheckpoint ?? 'n/a'}`,
  ].join(' | ');
}

function formatNullableCount(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

function truncate(value: string, width: number): string {
  if (visibleLength(value) <= width) {
    return value;
  }

  if (width <= 3) {
    return sliceAnsi(value, width);
  }

  return `${sliceAnsi(value, Math.max(width - 3, 1))}...`;
}

function formatIsoTime(value: Date | string): string {
  const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return iso.slice(11, 19);
}

function formatSignalPreviewCount(runtimeStats: RuntimeStatsLog | null): string {
  if (runtimeStats === null) {
    return 'n/a';
  }

  const total = Object.values(runtimeStats.signals.previewCountsBySignalId).reduce(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  return String(total);
}

function padRight(value: string, width: number): string {
  if (visibleLength(value) >= width) {
    return truncate(value, width);
  }

  return `${value}${' '.repeat(width - visibleLength(value))}`;
}

function renderTierChip(tier: PromotedAlertTier): string {
  return paint(` ${tier} `, getAlertTierAnsiCodes(tier));
}

function renderPreviewTierLine(
  tier: SignalPreview['walletLiveTier'],
  timestamp: string,
  signalId: SignalPreview['signal']['signalId'],
): string {
  const tierLabel = tier === 'CLEAN' ? paint(' CLEAN ', ['2', '37']) : renderTierChip(tier);
  return `${tierLabel} ${timestamp} ${signalId}`;
}

function paint(value: string, codes: string[]): string {
  return `\x1b[${codes.join(';')}m${value}\x1b[0m`;
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function sliceAnsi(value: string, maxVisibleChars: number): string {
  if (maxVisibleChars <= 0) {
    return '';
  }

  let visibleChars = 0;
  let output = '';
  let index = 0;
  let styleOpen = false;

  while (index < value.length && visibleChars < maxVisibleChars) {
    if (value[index] === '\u001b') {
      const terminatorIndex = value.indexOf('m', index);
      if (terminatorIndex === -1) {
        break;
      }

      const escapeSequence = value.slice(index, terminatorIndex + 1);
      output += escapeSequence;
      styleOpen = escapeSequence !== '\u001b[0m';
      index = terminatorIndex + 1;
      continue;
    }

    output += value[index];
    visibleChars += 1;
    index += 1;
  }

  if (styleOpen && !output.endsWith('\u001b[0m')) {
    output += '\u001b[0m';
  }

  return output;
}
