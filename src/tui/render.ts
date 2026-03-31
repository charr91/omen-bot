import type { RuntimeStatsLog } from '../engine/runtime-stats.js';
import type { PromotedAlert, PromotedAlertTier } from '../types/alert.js';

export type AlertFeedFilter = 'ALL' | PromotedAlertTier;

export interface DashboardRenderState {
  width: number;
  height: number;
  alerts: PromotedAlert[];
  tierFilter: AlertFeedFilter;
  dryRun: boolean;
  helpVisible: boolean;
  lastCheckpoint: string | null;
  lastStatusMessage: string | null;
  marketCount: number | null;
  walletCount: number | null;
  runtimeStats: RuntimeStatsLog | null;
}

const DASHBOARD_MIN_WIDTH = 80;
const DASHBOARD_MIN_HEIGHT = 16;

export function renderDashboard(state: DashboardRenderState): string {
  const width = Math.max(state.width, DASHBOARD_MIN_WIDTH);
  const height = Math.max(state.height, DASHBOARD_MIN_HEIGHT);

  if (state.helpVisible) {
    return renderHelp(width, state.dryRun, state.tierFilter);
  }

  const alerts = state.alerts.filter((alert) => {
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
  const controls = padRight('[q]Quit [?]Help [t]TierFilter [d]DryRun [Esc]Reset', width);
  const availableFeedLines = Math.max(height - 5, 4);
  const feedLines = renderAlertFeed(alerts, width, availableFeedLines);
  const statusMessage = padRight(state.lastStatusMessage ?? '', width);

  return [header, meta, divider, ...feedLines, divider, footer, statusMessage, controls]
    .slice(0, height)
    .join('\n');
}

function renderHelp(width: number, dryRun: boolean, tierFilter: AlertFeedFilter): string {
  return [
    padRight('OMEN Phase 1 Dashboard Help', width),
    padRight(`Current filter: ${tierFilter} | DryRun: ${dryRun ? 'ON' : 'OFF'}`, width),
    padRight('-'.repeat(width), width),
    padRight('q     Quit the dashboard and stop omen start', width),
    padRight('?     Toggle this help overlay', width),
    padRight('t     Cycle alert tier filter (ALL -> CRITICAL -> HIGH -> MEDIUM -> LOW)', width),
    padRight('d     Toggle external-alert dry-run mode for promoted alerts', width),
    padRight('Esc   Reset the filter and close help', width),
    padRight('', width),
    padRight('Signal previews are persisted LIVE signal events.', width),
    padRight('Alert feed shows promoted LOW/HIGH/CRITICAL operator alerts only.', width),
  ].join('\n');
}

function renderAlertFeed(alerts: PromotedAlert[], width: number, maxLines: number): string[] {
  if (alerts.length === 0) {
    return [
      padRight('Listening to Polymarket...', width),
      padRight('No promoted alerts yet. CLEAN signal events stay out of the alert feed.', width),
    ];
  }

  const lines: string[] = [];
  for (const alert of alerts) {
    const fillSize = alert.signal.evidence.find((entry) => entry.field === 'fill_size_usd')?.value;
    const timestamp = alert.promotedAt.slice(11, 19);
    lines.push(padRight(`[${alert.deliveryTier}] ${timestamp} ${alert.signal.signalId}`, width));
    lines.push(
      padRight(
        `${shortAddress(alert.walletAddress)} | score ${alert.walletLiveScore} | fill $${
          fillSize ?? 'n/a'
        }`,
        width,
      ),
    );
    lines.push(padRight(truncate(alert.marketQuestion, width), width));
    if (lines.length >= maxLines) {
      break;
    }
  }

  return lines.slice(0, maxLines);
}

function buildStatusLine(state: DashboardRenderState): string {
  const hotWorker = state.runtimeStats?.hotWorker ?? null;
  const restState = state.lastCheckpoint ? 'UP' : 'WAIT';
  const hotState = hotWorker === null ? 'WAIT' : hotWorker.processing || hotWorker.queueDepth > 0 ? 'BUSY' : 'IDLE';

  return [
    `REST:${restState}`,
    `Hot:${hotState}`,
    `Mkts:${formatNullableCount(state.marketCount)}`,
    `Wallets:${formatNullableCount(state.walletCount)}`,
    `Alerts:${state.alerts.length}`,
    `Queue:${hotWorker?.queueDepth ?? 'n/a'}`,
    `Pending:${hotWorker?.pendingFillCount ?? 'n/a'}`,
    `Checkpoint:${state.lastCheckpoint ?? 'n/a'}`,
  ].join(' | ');
}

function formatNullableCount(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

function shortAddress(address: string): string {
  if (address.length <= 10) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  return `${value.slice(0, Math.max(width - 3, 1))}...`;
}

function padRight(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }

  return `${value}${' '.repeat(width - value.length)}`;
}
