import { describe, expect, it } from 'vitest';
import type { BacktestCase } from '../../../src/backtest/cases.js';
import { BACKTEST_CASES } from '../../../src/backtest/cases.js';
import { BacktestDataSource, type RawTrade, type WalletHistory } from '../../../src/backtest/data.js';
import { median, summarizeCase, totals } from '../../../src/backtest/report.js';
import { candidateWallets, replayCase, walletAt, type ReplayConfig, type WalletHistoryPair } from '../../../src/backtest/replay.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config: ReplayConfig = {
  detection: {
    freshWallet: { criticalAgeHours: 24, elevatedAgeHours: 72, maxTransactions: 10 },
    market: { nicheMaxVolume: 100_000, largePositionMinUsd: 1_000, largePositionVolumePct: 0.02 },
    nicheMarketEntry: { maxMarketVolumeUsd: 100_000, minFillUsd: 1_000 },
    convictionSizeMismatch: { maxWalletTotalVolumeUsd: 5_000, minFillToWalletVolumeRatio: 0.5, longshotMaxPrice: 0.3, minFillUsd: 250 },
    lumpEntry: { minFillUsd: 500, minLumpRatio: 0.8 },
    excludedCategories: { sports: ['nba'] },
    cluster: { minSize: 3, minFillUsd: 200, elevatedFillUsd: 500, fundingMaxDepth: 4, fanoutLimit: 5, maxRpcCalls: 31, sameMarketSameSideWindowMs: 3_600_000 },
  },
  alerts: { criticalMinScore: 80, highMinScore: 60, mediumMinScore: 40, lowMinScore: 20, dedupCooldownMs: 86_400_000, dedupScoreIncrease: 10 },
  marketMaker: { filterEnabled: true, minScore: 70 },
} as unknown as ReplayConfig;

const CID = '0xabc';
const NEWS = '2026-01-03T06:00:00Z';
const newsS = Date.parse(NEWS) / 1000;
const testCase: BacktestCase = {
  id: 't',
  kind: 'insider',
  title: 'Will X happen?',
  conditionId: CID,
  winningOutcome: 'YES',
  windowStart: '2026-01-02T00:00:00Z',
  newsAt: NEWS,
  newsNote: '',
  reportedWallets: ['Insider-Guy'],
  sources: [],
};
const market = { conditionId: CID, question: 'Will X happen?', slug: 'x', eventSlug: 'x', volume: 50_000 };

function trade(over: Partial<RawTrade>): RawTrade {
  return {
    proxyWallet: '0x1111111111111111111111111111111111111111',
    side: 'BUY',
    asset: '1',
    conditionId: CID,
    size: 100,
    price: 0.5,
    timestamp: newsS - 3_600,
    outcome: 'Yes',
    transactionHash: `0x${Math.random().toString(16).slice(2)}`,
    ...over,
  };
}

const FRESH = '0x2222222222222222222222222222222222222222';
const pair = (h: WalletHistory, firstFillTs = newsS - 24 * 3600): WalletHistoryPair => ({ firstFillTs, pre: h, recent: h });
const OLD_SMALL = new Map<string, WalletHistoryPair>([
  [FRESH, pair({ wallet: FRESH, truncated: false, events: [{ timestamp: newsS - 30 * 86_400, conditionId: '0xother', type: 'TRADE', usdcSize: 100, side: 'BUY' }] })],
  ['0x1111111111111111111111111111111111111111', pair({ wallet: '0x1111111111111111111111111111111111111111', truncated: false, events: [{ timestamp: newsS - 30 * 86_400, conditionId: '0xother', type: 'TRADE', usdcSize: 100, side: 'BUY' }] })],
]);

describe('backtest replay', () => {
  it('flags a fresh wallet longshot on a niche market and measures lead time', () => {
    const trades = [
      trade({ timestamp: newsS - 20 * 3600, size: 2_000, price: 0.5 }), // $1k background volume
      trade({ proxyWallet: FRESH, timestamp: newsS - 5 * 3600, size: 20_000, price: 0.1, name: 'Insider-Guy' }), // $2k at 10c
    ];
    const histories = new Map<string, WalletHistoryPair>([
      [FRESH, pair({ wallet: FRESH, truncated: false, events: [{ timestamp: newsS - 6 * 3600, conditionId: '0xother', type: 'TRADE', usdcSize: 50, side: 'BUY' }] })],
    ]);
    const result = replayCase({ testCase, market, trades, histories, config });
    const hit = result.alerts.find((a) => a.wallet === FRESH)!;
    expect(hit.signals).toEqual(expect.arrayContaining(['FRESH_WALLET_LARGE_POSITION', 'CONVICTION_SIZE_MISMATCH', 'OUTSIZED_POSITION', 'NICHE_MARKET_ENTRY']));
    expect(hit.marketDailyVolumeUsd).toBeCloseTo(1_000);
    expect(hit.winningSide).toBe(true);
    const summary = summarizeCase(testCase, result);
    expect(summary.hit).toBe(true);
    expect(summary.leadHours).toBeCloseTo(5);
    expect(summary.reportedWalletFlagged).toBe(true);
  });

  it('ignores trades after the news cut-off and before the window', () => {
    const trades = [
      trade({ proxyWallet: FRESH, timestamp: newsS + 60, size: 20_000, price: 0.1 }),
      trade({ proxyWallet: FRESH, timestamp: Date.parse(testCase.windowStart) / 1000 - 60, size: 20_000, price: 0.1 }),
    ];
    const result = replayCase({ testCase, market, trades, histories: new Map(), config });
    expect(result.tradesInWindow).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it('treats a SELL of YES as a NO position (wrong side here)', () => {
    const trades = [trade({ proxyWallet: FRESH, side: 'SELL', timestamp: newsS - 3600, size: 3_000, price: 0.9 })];
    const result = replayCase({ testCase, market, trades, histories: OLD_SMALL, config });
    expect(result.alerts[0]!.effectiveOutcome).toBe('NO');
    expect(result.alerts[0]!.winningSide).toBe(false);
  });

  it('dedups repeat alerts for the same wallet within the cooldown', () => {
    const trades = [1, 2, 3].map((h) => trade({ timestamp: newsS - h * 3600, size: 4_000, price: 0.5 }));
    const result = replayCase({ testCase, market, trades, histories: OLD_SMALL, config });
    expect(result.alerts).toHaveLength(3);
    expect(result.alerts.filter((a) => a.delivered)).toHaveLength(1);
  });

  it('uses a conservative profile when a full activity page does not reach back before the fill', () => {
    const fill = {
      id: 'f', marketId: CID, tokenId: '1', walletAddress: FRESH, side: 'BUY' as const, outcome: 'YES' as const,
      price: '0.1', shares: '1000', sizeUsd: '100', txHash: '0x', orderType: 'TAKER' as const,
      timestamp: new Date((newsS - 7200) * 1000), analyzed: false, createdAt: new Date(),
    };
    const full = { wallet: FRESH, truncated: true, events: [{ timestamp: newsS - 60, conditionId: CID, type: 'TRADE' }] };
    // Later fill, recent page truncated and not reaching the first fill: gap, so unknown.
    const point = walletAt(fill, { firstFillTs: newsS - 3 * 3600, pre: { wallet: FRESH, truncated: false, events: [] }, recent: full }, config);
    expect(point.profile.activityAgeKnown).toBe(false);
    expect(point.profile.totalFills).toBe(1);
    expect(point.priorVolumeUsd).toBeNull();
    // First fill of a brand-new wallet: empty, complete pre-entry page, so age is known (fresh) despite later activity.
    const first = walletAt(fill, { firstFillTs: newsS - 7200, pre: { wallet: FRESH, truncated: false, events: [] }, recent: full }, config);
    expect(first.profile.activityAgeKnown).toBe(true);
    expect(first.profile.ageSeconds).toBe(0);
    expect(first.priorVolumeUsd).toBe(0);
  });

  it('selects candidate wallets above the lowest signal minimum, largest first, always keeping reported wallets', () => {
    const trades = [
      trade({ proxyWallet: '0xa', size: 1_000, price: 0.5 }),
      trade({ proxyWallet: '0xb', size: 10, price: 0.5 }),
      trade({ proxyWallet: '0xc', size: 10_000, price: 0.5 }),
      trade({ proxyWallet: '0xd', size: 1, price: 0.5, pseudonym: 'Insider-Guy' }),
    ];
    expect(candidateWallets(testCase, trades, config).map((c) => c.wallet)).toEqual(['0xd', '0xc', '0xa']);
  });

  it('computes totals: hit rate, median lead and control FP rate', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    const control: BacktestCase = { ...testCase, id: 'c', kind: 'control', winningOutcome: 'NO', reportedWallets: [] };
    const big = [trade({ timestamp: newsS - 3600, size: 4_000, price: 0.5 })];
    const t = totals([
      summarizeCase(testCase, replayCase({ testCase, market, trades: [], histories: new Map(), config })),
      summarizeCase(control, replayCase({ testCase: control, market, trades: big, histories: new Map(), config })),
    ]);
    expect(t.hits).toBe(0);
    expect(t.controls).toBe(1);
    expect(t.controlsWithAlert).toBe(0); // outsized + niche = 19, CLEAN: not a delivered MEDIUM+
  });

  it('ships 5-10 insider cases and controls with sources', () => {
    const insider = BACKTEST_CASES.filter((c) => c.kind === 'insider');
    expect(insider.length).toBeGreaterThanOrEqual(5);
    expect(insider.length).toBeLessThanOrEqual(10);
    expect(BACKTEST_CASES.some((c) => c.kind === 'control')).toBe(true);
    for (const c of BACKTEST_CASES) {
      expect(c.conditionId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(Date.parse(c.windowStart)).toBeLessThan(Date.parse(c.newsAt));
      expect(c.sources.length).toBeGreaterThan(0);
    }
  });
});

describe('backtest data source', () => {
  it('pages trades backwards by end, dedups, sorts, and caches to disk', async () => {
    const calls: string[] = [];
    const page1 = Array.from({ length: 10_000 }, (_, i) => trade({ timestamp: 2_000 - (i % 1000), transactionHash: `0x${i}` }));
    const page2 = [trade({ timestamp: 1_000, transactionHash: '0xp2' }), trade({ timestamp: 500, transactionHash: '0xlast' })];
    const get = async (url: string) => {
      calls.push(url);
      return url.includes('end=2000') ? page1 : page2;
    };
    const dir = mkdtempSync(join(tmpdir(), 'bt-'));
    const source = new BacktestDataSource(dir, get);
    const rows = await source.trades(CID, 0, 2_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('end=1001');
    expect(rows[0]!.transactionHash).toBe('0xlast');
    expect(rows).toHaveLength(10_002);
    const offline = new BacktestDataSource(dir, async () => { throw new Error('network'); }, { offline: true });
    expect(await offline.trades(CID, 0, 2_000)).toHaveLength(10_002);
    await expect(offline.market('0xnope')).rejects.toThrow(/offline/);
  });
});

describe('mergeFindings', () => {
  it('keeps the marker-delimited findings block and migrates a legacy ## Findings section', async () => {
    const { mergeFindings, FINDINGS_START, FINDINGS_END } = await import('../../../src/backtest/report.js');
    const legacy = '# R\n\nold\n\n## Findings\n\n1. hand\n';
    const first = mergeFindings('# R\n\nnew', legacy);
    expect(first).toBe(`# R\n\nnew\n\n${FINDINGS_START}\n## Findings\n\n1. hand\n${FINDINGS_END}`);
    expect(mergeFindings('# R\n\nnewer', first)).toBe(first.replace('new\n', 'newer\n'));
    expect(mergeFindings('# R', null)).toBe(`# R\n\n${FINDINGS_START}\n${FINDINGS_END}`);
  });
});
