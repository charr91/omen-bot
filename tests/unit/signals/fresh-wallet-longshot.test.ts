import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { computeCompositeLiveScore, computeDeliverableLiveScore, evaluateLiveSignals } from '../../../src/signals/evaluate-live-signals.js';
import { evaluateFreshWalletLongshot, isShadowSignal } from '../../../src/signals/fresh-wallet-longshot.js';
import { deriveAlertTier } from '../../../src/signals/scoring.js';
import { SignalId } from '../../../src/types/signal.js';
import type { FillRecord } from '../../../src/types/fill.js';
import type { WalletProfile } from '../../../src/types/wallet.js';

function makeConfig(deliver = false): Pick<AppConfig, 'detection'> {
  return {
    detection: {
      freshWallet: { criticalAgeHours: 24, elevatedAgeHours: 72, maxTransactions: 10 },
      market: { nicheMaxVolume: 100_000, largePositionMinUsd: 1_000, largePositionVolumePct: 0.02 },
      nicheMarketEntry: { maxMarketVolumeUsd: 100_000, minFillUsd: 1_000 },
      convictionSizeMismatch: { maxWalletTotalVolumeUsd: 5_000, minFillToWalletVolumeRatio: 0.5, longshotMaxPrice: 0.3, minFillUsd: 250 },
      lumpEntry: { minFillUsd: 500, minLumpRatio: 0.8 },
      excludedCategories: {},
      cluster: { minSize: 3, minFillUsd: 25, elevatedFillUsd: 500, fundingMaxDepth: 4, fanoutLimit: 5, maxRpcCalls: 200, sameMarketSameSideWindowMs: 3_600_000 },
      freshWalletLongshot: { enabled: true, deliver, maxAgeHours: 24, maxTransactions: 10, maxPrice: 0.3, minStakeUsd: 5_000, score: 40 },
    },
  };
}

const wallet = (o: Partial<WalletProfile> = {}): WalletProfile => ({
  address: '0xw', ageSeconds: 2 * 3600, activityAgeKnown: true, totalTransactions: 3, isContract: false, controllerAddress: null,
  firstSeenAt: new Date(), lastActiveAt: new Date(), totalMarkets: 0, totalFills: 0, totalVolumeUsd: '0',
  liveSuspicionScore: 0, liveTier: 'CLEAN', isWhitelisted: false, ...o,
});

const fill = (o: Partial<FillRecord> = {}): FillRecord => ({
  id: 'f', marketId: 'm', tokenId: 't', walletAddress: '0xw', side: 'BUY', outcome: 'YES', price: '0.10', shares: '60000',
  sizeUsd: '6000', txHash: '0x', orderType: 'UNKNOWN', timestamp: new Date(), analyzed: false, createdAt: new Date(), ...o,
});

const alertsConfig = { alerts: { criticalMinScore: 80, highMinScore: 60, mediumMinScore: 40, lowMinScore: 20, dedupCooldownMs: 0, dedupScoreIncrease: 10 } };

describe('evaluateFreshWalletLongshot', () => {
  it('fires on a fresh wallet staking >= $5k on a longshot, reaching MEDIUM alone, shadowed when deliver = false', () => {
    const s = evaluateFreshWalletLongshot({ fill: fill(), wallet: wallet(), config: makeConfig() });
    expect(s?.signalId).toBe(SignalId.FRESH_WALLET_LONGSHOT);
    expect(deriveAlertTier(s!.score, alertsConfig)).toBe('MEDIUM');
    expect(isShadowSignal(s!)).toBe(true);
    expect(isShadowSignal(evaluateFreshWalletLongshot({ fill: fill(), wallet: wallet(), config: makeConfig(true) })!)).toBe(false);
  });

  it('respects age, txn, price and stake bounds', () => {
    const c = makeConfig();
    expect(evaluateFreshWalletLongshot({ fill: fill(), wallet: wallet({ ageSeconds: 25 * 3600 }), config: c })).toBeNull();
    expect(evaluateFreshWalletLongshot({ fill: fill(), wallet: wallet({ totalTransactions: 11 }), config: c })).toBeNull();
    expect(evaluateFreshWalletLongshot({ fill: fill(), wallet: wallet({ activityAgeKnown: false }), config: c })).toBeNull();
    expect(evaluateFreshWalletLongshot({ fill: fill({ price: '0.35', shares: '20000', sizeUsd: '7000' }), wallet: wallet(), config: c })).toBeNull();
    expect(evaluateFreshWalletLongshot({ fill: fill({ shares: '40000', sizeUsd: '4000' }), wallet: wallet(), config: c })).toBeNull();
  });

  it('uses the effective position: SELL YES at 0.80 is a NO longshot at 0.20', () => {
    const s = evaluateFreshWalletLongshot({ fill: fill({ side: 'SELL', price: '0.80', shares: '30000', sizeUsd: '24000' }), wallet: wallet(), config: makeConfig() });
    expect(s).not.toBeNull();
    expect(evaluateFreshWalletLongshot({ fill: fill({ side: 'SELL', price: '0.10', shares: '60000', sizeUsd: '6000' }), wallet: wallet(), config: makeConfig() })).toBeNull();
  });

  it('fires at any market size and shadow signals do not count toward the deliverable score', () => {
    const signals = evaluateLiveSignals({
      fill: fill(), wallet: wallet(), market: { id: 'm', eventSlug: null, question: 'Q?', marketSlug: 'q', dailyVolumeUsd: '5000000', volumeUsd: '1', liquidityUsd: '1' },
      config: makeConfig(), cluster: null,
    });
    expect(signals.map((s) => s.signalId)).toContain(SignalId.FRESH_WALLET_LONGSHOT);
    expect(signals.map((s) => s.signalId)).not.toContain(SignalId.FRESH_WALLET_LARGE_POSITION);
    expect(computeCompositeLiveScore(signals) - computeDeliverableLiveScore(signals)).toBe(40);
  });

  it('is off when the config section is absent', () => {
    const { freshWalletLongshot: _omit, ...detection } = makeConfig().detection;
    expect(evaluateFreshWalletLongshot({ fill: fill(), wallet: wallet(), config: { detection } })).toBeNull();
  });
});
