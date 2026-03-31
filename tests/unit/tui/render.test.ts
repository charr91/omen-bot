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
});
