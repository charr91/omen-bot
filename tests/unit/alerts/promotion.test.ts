import { describe, expect, it } from 'vitest';
import { promoteSignalPreview } from '../../../src/alerts/promote.js';
import { SignalId } from '../../../src/types/signal.js';

describe('promoteSignalPreview', () => {
  it('returns null for CLEAN signal previews', () => {
    const result = promoteSignalPreview({
      fillId: 'fill-1',
      walletAddress: '0xabc',
      marketId: 'market-1',
      marketQuestion: 'Will X happen?',
      walletLiveScore: 12,
      walletLiveTier: 'CLEAN',
      signal: {
        signalId: SignalId.OUTSIZED_POSITION,
        availability: 'LIVE',
        score: 12,
        confidence: 0.8,
        evidence: [],
        triggeredAt: new Date('2026-03-31T02:00:00.000Z'),
      },
      promotedAlertId: null,
      promotedAt: null,
      dryRun: false,
    });

    expect(result).toBeNull();
  });

  it('promotes LOW+ signal previews into operator alerts', () => {
    const result = promoteSignalPreview(
      {
        fillId: 'fill-1',
        walletAddress: '0xabc',
        marketId: 'market-1',
        marketQuestion: 'Will X happen?',
        walletLiveScore: 32,
        walletLiveTier: 'LOW',
        signal: {
          signalId: SignalId.OUTSIZED_POSITION,
          availability: 'LIVE',
          score: 12,
          confidence: 0.8,
          evidence: [],
          triggeredAt: new Date('2026-03-31T02:00:00.000Z'),
        },
        promotedAlertId: null,
        promotedAt: null,
        dryRun: false,
      },
      new Date('2026-03-31T02:01:00.000Z'),
    );

    expect(result).toMatchObject({
      deliveryTier: 'LOW',
      promotedAt: '2026-03-31T02:01:00.000Z',
    });
  });
});
