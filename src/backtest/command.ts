import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadAppConfig } from '../config/index.js';
import { BACKTEST_CASES } from './cases.js';
import { BacktestDataSource, mapLimit } from './data.js';
import { mergeFindings, renderMarkdown, summarizeCase, totals, type CaseSummary } from './report.js';
import { candidateWallets, replayCase, type ReplayConfig, type WalletHistoryPair } from './replay.js';

export interface BacktestOptions {
  out: string;
  json: string | null;
  cacheDir: string;
  offline: boolean;
  refresh: boolean;
  only: string[];
  maxWallets: number;
  concurrency: number;
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
  };
}

/** `omen backtest`: offline replay of BACKTEST_CASES; writes the markdown report (and optional JSON). */
export async function runBacktestCommand(options: BacktestOptions, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<string> {
  // The replay never opens a connection; loadAppConfig only validates that these are set.
  process.env.DATABASE_URL ||= 'postgres://backtest.invalid/none';
  process.env.REDIS_URL ||= 'redis://backtest.invalid:0';
  const config = await loadAppConfig();
  const source = new BacktestDataSource(resolve(options.cacheDir), undefined, { offline: options.offline, refresh: options.refresh });
  const cases = options.only.length ? BACKTEST_CASES.filter((c) => options.only.includes(c.id)) : BACKTEST_CASES;
  const summaries: CaseSummary[] = [];
  const variantSummaries: CaseSummary[] = [];
  const longshotSummaries: CaseSummary[] = [];
  for (const testCase of cases) {
    const start = Math.floor(Date.parse(testCase.windowStart) / 1000) - 86_400;
    const end = Math.floor(Date.parse(testCase.newsAt) / 1000);
    const market = await source.market(testCase.conditionId);
    const trades = await source.trades(testCase.conditionId, start, end);
    const wallets = candidateWallets(testCase, trades, config).slice(0, options.maxWallets);
    log(`[backtest] ${testCase.id}: ${trades.length} trades, profiling ${wallets.length} wallets`);
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
    // FRESH_WALLET_LONGSHOT runs in shadow mode live; this replay delivers it to measure what it would add.
    if (config.detection.freshWalletLongshot) {
      const delivered: ReplayConfig = { ...config, detection: { ...config.detection, freshWalletLongshot: { ...config.detection.freshWalletLongshot, enabled: true, deliver: true } } };
      longshotSummaries.push(summarizeCase(testCase, replayCase({ testCase, market, trades, histories, config: delivered })));
    }
  }
  const generated = renderMarkdown(summaries, {
    generatedAt: new Date().toISOString(),
    configPath: 'omen.config.toml',
    variants: [{ label: 'FRESH_WALLET without the niche gate (detection.market.niche_max_volume = ∞)', summaries: variantSummaries }],
    shadow: longshotSummaries.length ? { signalId: 'FRESH_WALLET_LONGSHOT', summaries: longshotSummaries } : undefined,
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
      JSON.stringify({ totals: totals(summaries), variantTotals: totals(variantSummaries), longshotDeliveredTotals: longshotSummaries.length ? totals(longshotSummaries) : null, cases: summaries.map((s) => ({ ...s, result: { ...s.result, alerts: s.result.alerts.filter((a) => a.tier !== 'CLEAN') } })) }, null, 2),
    );
  }
  return markdown;
}
