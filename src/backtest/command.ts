import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadAppConfig } from '../config/index.js';
import { BACKTEST_CASES } from './cases.js';
import { BacktestDataSource, mapLimit, setRequestRate } from './data.js';
import { bandMatched, HORIZONS, moveRow, pricerFor, type Horizon, type MoveRow } from './moves.js';
import { mergeFindings, renderMarkdown, signalScorecard, summarizeCase, totals, type CaseSummary, type MovesCell, type MovesReport } from './report.js';
import { candidateWallets, deliveredSignalIds, replayCase, type ReplayConfig, type WalletHistoryPair } from './replay.js';
import { SignalId } from '../types/signal.js';

export interface BacktestOptions {
  out: string;
  json: string | null;
  cacheDir: string;
  offline: boolean;
  refresh: boolean;
  only: string[];
  maxWallets: number;
  concurrency: number;
  /** Max HTTP requests started per second (polite pacing for the public APIs). */
  rps: number;
}

export function parseBacktestOptions(argv: string[]): BacktestOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', default: 'docs/backtests/m2-insider-cases.md' },
      json: { type: 'string' },
      'cache-dir': { type: 'string', default: '.backtest-cache' },
      offline: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      only: { type: 'string', multiple: true },
      'max-wallets': { type: 'string', default: '4000' },
      concurrency: { type: 'string', default: '6' },
      rps: { type: 'string', default: '5' },
    },
    allowPositionals: false,
  });
  return {
    out: values.out!,
    json: values.json ?? null,
    cacheDir: values['cache-dir']!,
    offline: values.offline!,
    refresh: values.refresh!,
    only: values.only ?? [],
    maxWallets: Number(values['max-wallets']),
    concurrency: Number(values.concurrency),
    rps: Number(values.rps),
  };
}

/** `omen backtest`: offline replay of BACKTEST_CASES; writes the markdown report (and optional JSON). */
export async function runBacktestCommand(options: BacktestOptions, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<string> {
  // The replay never opens a connection; loadAppConfig only validates that these are set.
  process.env.DATABASE_URL ||= 'postgres://backtest.invalid/none';
  process.env.REDIS_URL ||= 'redis://backtest.invalid:0';
  const config = await loadAppConfig();
  setRequestRate(options.rps);
  const source = new BacktestDataSource(resolve(options.cacheDir), undefined, { offline: options.offline, refresh: options.refresh });
  const cases = options.only.length ? BACKTEST_CASES.filter((c) => options.only.includes(c.id)) : BACKTEST_CASES;
  const delivered = deliveredSignalIds(config);
  const summaries: CaseSummary[] = [];
  const variantSummaries: CaseSummary[] = [];
  const signalRows = new Map<string, { fired: MoveRow[]; delivered: MoveRow[] }>();
  const baselineRows: MoveRow[] = [];
  for (const testCase of cases) {
    const start = Math.floor(Date.parse(testCase.windowStart) / 1000) - 86_400;
    const end = Math.floor(Date.parse(testCase.newsAt) / 1000);
    const market = await source.market(testCase.conditionId);
    const trades = await source.trades(testCase.conditionId, start, end);
    // Post-news tape for the +1h / +24h prices of fills just before the news.
    const post = await source.trades(testCase.conditionId, end + 1, end + 25 * 3600);
    const wallets = candidateWallets(testCase, trades, config).slice(0, options.maxWallets);
    log(`[backtest] ${testCase.id}: ${trades.length} trades (+${post.length} post-news), profiling ${wallets.length} wallets`);
    const histories = new Map<string, WalletHistoryPair>();
    let done = 0;
    await mapLimit(wallets, options.concurrency, async ({ wallet: w, firstFillTs }) => {
      const recent = await source.walletHistory(w, end);
      // One page usually reaches back past the first fill; only fetch the pre-entry page when it does not.
      const reaches = !recent.truncated || recent.events.some((e) => e.timestamp < firstFillTs);
      const pre = reaches ? recent : await source.walletHistory(w, firstFillTs - 1);
      histories.set(w, { firstFillTs, pre, recent });
      done += 1;
      if (done % 500 === 0) log(`[backtest]   ${done}/${wallets.length}`);
    });
    const result = replayCase({ testCase, market, trades, histories, config });
    summaries.push(summarizeCase(testCase, result));
    // What-if (not shipped): fresh-wallet without its niche-market gate, on the same data.
    const variant: ReplayConfig = { ...config, detection: { ...config.detection, market: { ...config.detection.market, nicheMaxVolume: Number.POSITIVE_INFINITY } } };
    variantSummaries.push(summarizeCase(testCase, replayCase({ testCase, market, trades, histories, config: variant })));

    const pricer = pricerFor(testCase, market, [...trades, ...post]);
    for (const f of result.baselineFills) baselineRows.push(moveRow(testCase, f, pricer));
    for (const f of result.signalFills) {
      const row = moveRow(testCase, f, pricer);
      for (const id of f.signals ?? []) {
        const bucket = signalRows.get(id) ?? { fired: [], delivered: [] };
        bucket.fired.push(row);
        if (f.delivered && f.tier && ['MEDIUM', 'HIGH', 'CRITICAL'].includes(f.tier) && (f.deliverableSignals ?? []).includes(id)) bucket.delivered.push(row);
        signalRows.set(id, bucket);
      }
    }
  }
  const moves = buildMovesReport(signalRows, baselineRows, delivered);
  const generated = renderMarkdown(summaries, {
    generatedAt: new Date().toISOString(),
    configPath: 'omen.config.toml',
    variants: [{ label: 'FRESH_WALLET without the niche gate (detection.market.niche_max_volume = ∞)', summaries: variantSummaries }],
    deliveredSignals: delivered,
    moves,
  });
  // Keep the hand-written Findings block of the existing report across regenerations.
  const previous = await readFile(resolve(options.out), 'utf8').catch(() => null);
  const markdown = mergeFindings(generated, previous);
  await mkdir(dirname(resolve(options.out)), { recursive: true });
  await writeFile(resolve(options.out), `${markdown}\n`);
  if (options.json) {
    await mkdir(dirname(resolve(options.json)), { recursive: true });
    await writeFile(
      resolve(options.json),
      JSON.stringify(
        {
          totals: totals(summaries),
          deliveredSignals: delivered.map((id) => signalScorecard(id, summaries)),
          variantTotals: totals(variantSummaries),
          moves: moves.rows,
          cases: summaries.map((s) => ({
            ...s,
            result: { ...s.result, alerts: s.result.alerts.filter((a) => a.tier !== 'CLEAN'), signalFills: undefined, baselineFills: undefined, signalFillCount: s.result.signalFills.length, baselineFillCount: s.result.baselineFills.length },
          })),
        },
        null,
        2,
      ),
    );
  }
  return markdown;
}

const SIGNAL_ORDER: string[] = [
  SignalId.FRESH_WALLET_LARGE_POSITION,
  SignalId.CONVICTION_SIZE_MISMATCH,
  SignalId.FRESH_WALLET_LONGSHOT,
  SignalId.NICHE_MARKET_ENTRY,
  SignalId.OUTSIZED_POSITION,
  SignalId.LUMP_ENTRY,
];

/** Signal vs same-market, same-band baseline per horizon; delivered signals also split by scope and case kind. */
export function buildMovesReport(signalRows: Map<string, { fired: MoveRow[]; delivered: MoveRow[] }>, baseline: MoveRow[], delivered: string[]): MovesReport {
  const rows: MovesReport['rows'] = [];
  const cellsFor = (sig: MoveRow[]): Record<Horizon, MovesCell> =>
    Object.fromEntries(HORIZONS.map((h) => [h, bandMatched(sig, baseline, h)])) as Record<Horizon, MovesCell>;
  for (const id of SIGNAL_ORDER) {
    const b = signalRows.get(id) ?? { fired: [], delivered: [] };
    const isDelivered = delivered.includes(id);
    const scopes: ('fired' | 'delivered')[] = isDelivered ? ['fired', 'delivered'] : ['fired'];
    for (const scope of scopes) {
      const all = b[scope];
      const subsets: ('all' | 'insider' | 'control')[] = isDelivered ? ['all', 'insider', 'control'] : ['all'];
      for (const subset of subsets) {
        const sig = subset === 'all' ? all : all.filter((r) => r.kind === subset);
        rows.push({ signalId: id, scope, subset, cells: cellsFor(sig) });
      }
    }
  }
  return { rows, baselineFills: baseline.length };
}
