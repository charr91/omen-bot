import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../../../src/tui/render.js';
import type { PresentableAlert, SignalPreview } from '../../../src/types/alert.js';
import { SignalId } from '../../../src/types/signal.js';

function makeAlert(overrides: Partial<PresentableAlert> = {}): PresentableAlert {
  return {
    fillId: 'fill-1',
    walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    marketId: 'market-1',
    marketQuestion: 'Will the highest temperature in Toronto be 7C on March 31?',
    fillSide: 'BUY',
    fillOutcome: 'YES',
    fillPrice: '0.62',
    fillSizeUsd: '2296.37',
    fillTimestamp: '2026-03-31T02:00:00.000Z',
    walletLiveScore: 42,
    walletLiveTier: 'MEDIUM',
    deliveryTier: 'MEDIUM',
    signal: {
      signalId: SignalId.OUTSIZED_POSITION,
      availability: 'LIVE',
      score: 12,
      confidence: 0.8,
      evidence: [
        {
          field: 'fill_size_usd',
          value: 2296.37,
          threshold: 1000,
          description: 'Single-fill notional',
        },
      ],
      triggeredAt: new Date('2026-03-31T02:00:00.000Z'),
    },
    promotedAlertId: null,
    promotedAt: '2026-03-31T02:01:00.000Z',
    dryRun: false,
    ...overrides,
  };
}

function makeSignalPreview(overrides: Partial<SignalPreview> = {}): SignalPreview {
  return {
    fillId: 'preview-fill-1',
    walletAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    marketId: 'market-1',
    marketQuestion: 'Will the Bank of Canada cut rates this month?',
    fillSide: 'BUY',
    fillOutcome: 'YES',
    fillPrice: '0.48',
    fillSizeUsd: '1830.55',
    fillTimestamp: '2026-03-31T02:02:03.000Z',
    walletLiveScore: 12,
    walletLiveTier: 'CLEAN',
    signal: {
      signalId: SignalId.OUTSIZED_POSITION,
      availability: 'LIVE',
      score: 12,
      confidence: 0.8,
      evidence: [
        {
          field: 'fill_size_usd',
          value: 1830.55,
          threshold: 1000,
          description: 'Single-fill notional',
        },
      ],
      triggeredAt: new Date('2026-03-31T02:02:03.000Z'),
    },
    promotedAlertId: null,
    promotedAt: null,
    dryRun: false,
    ...overrides,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('renderDashboard', () => {
  it('renders an empty listening state when no promoted alerts exist', () => {
    const output = stripAnsi(
      renderDashboard({
        width: 100,
        height: 20,
        alerts: [],
        signalPreviews: [],
        tierFilter: 'ALL',
        dryRun: false,
        helpVisible: false,
        lastCheckpoint: null,
        lastStatusMessage: null,
        marketCount: null,
        walletCount: null,
        runtimeStats: null,
        shuttingDown: false,
        shutdownMessage: null,
      }),
    );

    expect(output).toContain('Listening to Polymarket...');
    expect(output).toContain('No promoted alerts yet');
    expect(output).toContain('State:RUNNING');
  });

  it('renders promoted alerts and hides those outside the selected tier filter', () => {
    const output = stripAnsi(
      renderDashboard({
        width: 100,
        height: 20,
        alerts: [
          makeAlert({
            linkedTradeContext: {
              oppositeSide: 'SELL',
              recentCount: 1,
              latest: {
                fillId: 'prior-fill-1',
                fillSide: 'SELL',
                fillOutcome: 'NO',
                fillPrice: '0.55',
                fillSizeUsd: '900',
                fillTimestamp: '2026-03-31T01:59:00.000Z',
              },
            },
          }),
          makeAlert({ deliveryTier: 'LOW', walletLiveTier: 'LOW' }),
        ],
        signalPreviews: [],
        tierFilter: 'MEDIUM',
        dryRun: true,
        helpVisible: false,
        lastCheckpoint: '2026-03-31T02:05:17.000Z',
        lastStatusMessage: 'Telegram dry-run enabled',
        marketCount: 12,
        walletCount: 34,
        runtimeStats: null,
        shuttingDown: false,
        shutdownMessage: null,
      }),
    );

    expect(output).toContain('MEDIUM  02:00:00 OUTSIZED_POSITION');
    expect(output).not.toContain('LOW  02:00:00 OUTSIZED_POSITION');
    expect(output).toContain('This trade is unusually large for this market: $2,296.37 against a threshold of $1,000.');
    expect(output).toContain('Bought YES @ 0.62 | fill $2,296.37 | score 42 (MEDIUM)');
    expect(output).toContain('after 1 recent sell');
    expect(output).toContain('DryRun: ON');
    expect(output).toContain('Telegram dry-run enabled');
  });

  it('shows recent signal previews when no promoted alerts exist yet', () => {
    const output = stripAnsi(
      renderDashboard({
        width: 140,
        height: 20,
        alerts: [],
        signalPreviews: [makeSignalPreview()],
        tierFilter: 'ALL',
        dryRun: false,
        helpVisible: false,
        lastCheckpoint: '2026-03-31T02:05:17.000Z',
        lastStatusMessage: null,
        marketCount: 12,
        walletCount: 34,
        runtimeStats: {
          type: 'runtime-stats',
          collectedAt: '2026-03-31T02:05:17.000Z',
          windowSeconds: 60,
          ingest: {
            cycles: 1,
            fetched: 2,
            inserted: 2,
            replayAccepted: 2,
          },
          hotWorker: {
            enqueueAccepted: 2,
            enqueueDuplicate: 0,
            enqueueFull: 0,
            processed: 2,
            failed: 0,
            queueDepth: 0,
            pendingFillCount: 0,
            processing: false,
            lastHeartbeatAt: '2026-03-31T02:05:17.000Z',
            lastProcessedAt: '2026-03-31T02:05:10.000Z',
            lastProcessedAgeMs: 7000,
          },
          signals: {
            previewCountsBySignalId: {
              OUTSIZED_POSITION: 1,
            },
          },
          coldPath: {
            waitingCount: 2,
            activeCount: 1,
            failedCount: 0,
            delayedCount: 0,
            lastHeartbeatAt: '2026-03-31T02:05:17.000Z',
            lastCompletedAt: '2026-03-31T02:05:12.000Z',
            lastFailedAt: null,
          },
        },
        shuttingDown: false,
        shutdownMessage: null,
      }),
    );

    expect(output).toContain('No promoted alerts yet. Recent LIVE signal previews:');
    expect(output).toContain('CLEAN  02:02:03 OUTSIZED_POSITION');
    expect(output).toContain('Bought YES @ 0.48 | fill $1,830.55 | score 12 (CLEAN)');
    expect(output).toContain('Prev60s:1');
    expect(output).toContain('Cold:BUSY');
    expect(output).toContain('ColdQ:2');
  });

  it('explains when the selected tier filter hides all promoted alerts', () => {
    const output = stripAnsi(
      renderDashboard({
        width: 100,
        height: 20,
        alerts: [makeAlert({ deliveryTier: 'LOW', walletLiveTier: 'LOW' })],
        signalPreviews: [makeSignalPreview()],
        tierFilter: 'HIGH',
        dryRun: false,
        helpVisible: false,
        lastCheckpoint: '2026-03-31T02:05:17.000Z',
        lastStatusMessage: null,
        marketCount: 12,
        walletCount: 34,
        runtimeStats: null,
        shuttingDown: false,
        shutdownMessage: null,
      }),
    );

    expect(output).toContain('Promoted alerts exist, but none match the current tier filter.');
  });

  it('renders explicit shutdown feedback when the dashboard is stopping', () => {
    const output = stripAnsi(
      renderDashboard({
        width: 100,
        height: 20,
        alerts: [],
        signalPreviews: [],
        tierFilter: 'ALL',
        dryRun: false,
        helpVisible: false,
        lastCheckpoint: '2026-03-31T02:05:17.000Z',
        lastStatusMessage: 'old status',
        marketCount: 12,
        walletCount: 34,
        runtimeStats: null,
        shuttingDown: true,
        shutdownMessage: 'Shutting down...',
      }),
    );

    expect(output).toContain('State:STOPPING');
    expect(output).toContain('Shutting down...');
    expect(output).toContain('Stopping... waiting for ingest, hot worker, and cold worker to exit');
  });
});
