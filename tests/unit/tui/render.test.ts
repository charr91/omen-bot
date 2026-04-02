import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../../../src/tui/render.js';
import type { PromotedAlert } from '../../../src/types/alert.js';
import { SignalId } from '../../../src/types/signal.js';

function makeAlert(overrides: Partial<PromotedAlert> = {}): PromotedAlert {
  return {
    fillId: 'fill-1',
    walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    marketId: 'market-1',
    marketQuestion: 'Will the highest temperature in Toronto be 7C on March 31?',
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

describe('renderDashboard', () => {
  it('renders an empty listening state when no promoted alerts exist', () => {
    const output = renderDashboard({
      width: 100,
      height: 20,
      alerts: [],
      tierFilter: 'ALL',
      dryRun: false,
      helpVisible: false,
      lastCheckpoint: null,
      lastStatusMessage: null,
      marketCount: null,
      walletCount: null,
      runtimeStats: null,
    });

    expect(output).toContain('Listening to Polymarket...');
    expect(output).toContain('No promoted alerts yet');
    expect(output).toContain('State:RUNNING');
  });

  it('renders promoted alerts and hides those outside the selected tier filter', () => {
    const output = renderDashboard({
      width: 100,
      height: 20,
      alerts: [makeAlert(), makeAlert({ deliveryTier: 'LOW', walletLiveTier: 'LOW' })],
      tierFilter: 'MEDIUM',
      dryRun: true,
      helpVisible: false,
      lastCheckpoint: '2026-03-31T02:05:17.000Z',
      lastStatusMessage: 'Telegram dry-run enabled',
      marketCount: 12,
      walletCount: 34,
      runtimeStats: null,
    });

    expect(output).toContain('[MEDIUM]');
    expect(output).not.toContain('[LOW]');
    expect(output).toContain('DryRun: ON');
    expect(output).toContain('Telegram dry-run enabled');
  });

  it('shows cold-path runtime state when no promoted alerts exist yet', () => {
    const output = renderDashboard({
      width: 140,
      height: 20,
      alerts: [],
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
    });

    expect(output).toContain('Listening to Polymarket...');
    expect(output).toContain('State:RUNNING');
    expect(output).toContain('Cold:BUSY');
    expect(output).toContain('ColdQ:2');
  });

  it('explains when the selected tier filter hides all promoted alerts', () => {
    const output = renderDashboard({
      width: 100,
      height: 20,
      alerts: [makeAlert({ deliveryTier: 'LOW', walletLiveTier: 'LOW' })],
      tierFilter: 'HIGH',
      dryRun: false,
      helpVisible: false,
      lastCheckpoint: '2026-03-31T02:05:17.000Z',
      lastStatusMessage: null,
      marketCount: 12,
      walletCount: 34,
      runtimeStats: null,
    });

    expect(output).toContain('Promoted alerts exist, but none match the current tier filter.');
  });

  it('renders explicit shutdown feedback when the dashboard is stopping', () => {
    const output = renderDashboard({
      width: 100,
      height: 20,
      alerts: [],
      tierFilter: 'ALL',
      dryRun: false,
      helpVisible: false,
      lastCheckpoint: '2026-03-31T02:05:17.000Z',
      lastStatusMessage: 'old status',
      marketCount: 12,
      walletCount: 34,
      runtimeStats: null,
      shuttingDown: true,
    });

    expect(output).toContain('State:STOPPING');
    expect(output).toContain('Shutting down...');
    expect(output).toContain('Stopping... waiting for ingest, hot worker, and cold worker to exit');
    expect(output).not.toContain('old status');
  });
});
