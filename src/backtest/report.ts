import type { BacktestCase } from './cases.js';
import { TIER_RANK, type ReplayAlert, type ReplayResult } from './replay.js';
import type { AlertTier } from '../types/signal.js';

/** omen's Telegram delivery floor: LOW alerts are promoted to the feed for grading, MEDIUM+ reach a chat. */
export const DELIVERY_MIN_TIER: AlertTier = 'MEDIUM';

export interface CaseSummary {
  testCase: BacktestCase;
  result: ReplayResult;
  hit: boolean;
  /** Best tier among winning-side delivered alerts before the news. */
  bestWinningTier: AlertTier;
  firstHitAt: number | null;
  leadHours: number | null;
  firstAnyAlertLeadHours: number | null;
  signalsFired: Record<string, number>;
  tierCounts: Record<AlertTier, number>;
  wrongSideDelivered: number;
  reportedWalletFlagged: boolean | null;
}

function atLeast(alert: ReplayAlert, tier: AlertTier): boolean {
  return alert.delivered && TIER_RANK[alert.tier] >= TIER_RANK[tier];
}

export function summarizeCase(testCase: BacktestCase, result: ReplayResult, minTier: AlertTier = DELIVERY_MIN_TIER): CaseSummary {
  const newsAt = Date.parse(testCase.newsAt) / 1000;
  const delivered = result.alerts.filter((a) => a.delivered);
  const winning = delivered.filter((a) => a.winningSide && atLeast(a, minTier));
  const first = winning.length > 0 ? Math.min(...winning.map((a) => a.timestamp)) : null;
  const firstAny = delivered.length > 0 ? Math.min(...delivered.map((a) => a.timestamp)) : null;
  const signalsFired: Record<string, number> = {};
  const tierCounts: Record<AlertTier, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, CLEAN: 0 };
  for (const a of delivered) {
    tierCounts[a.tier] += 1;
    for (const s of a.signals) signalsFired[s] = (signalsFired[s] ?? 0) + 1;
  }
  let best: AlertTier = 'CLEAN';
  for (const a of delivered) if (a.winningSide && TIER_RANK[a.tier] > TIER_RANK[best]) best = a.tier;
  const reportedWalletFlagged =
    (testCase.reportedWallets?.length ?? 0) === 0 || result.reportedFills.length === 0
      ? null
      : result.reportedFills.some((f) => TIER_RANK[f.tier] >= TIER_RANK[minTier]);
  return {
    testCase,
    result,
    hit: first !== null,
    bestWinningTier: best,
    firstHitAt: first,
    leadHours: first === null ? null : (newsAt - first) / 3600,
    firstAnyAlertLeadHours: firstAny === null ? null : (newsAt - firstAny) / 3600,
    signalsFired,
    tierCounts,
    wrongSideDelivered: delivered.filter((a) => !a.winningSide && atLeast(a, minTier)).length,
    reportedWalletFlagged,
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface BacktestTotals {
  insiderCases: number;
  hits: number;
  medianLeadHours: number | null;
  controls: number;
  controlsWithAlert: number;
  /** Controls with >= 1 delivered MEDIUM+ alert / controls. */
  falsePositiveRate: number | null;
  controlAlertsPerDay: number | null;
  /** Share of delivered MEDIUM+ alerts in insider markets that were on the losing side. */
  insiderWrongSideShare: number | null;
}

export function totals(summaries: CaseSummary[]): BacktestTotals {
  const insider = summaries.filter((s) => s.testCase.kind === 'insider');
  const controls = summaries.filter((s) => s.testCase.kind === 'control');
  const controlHits = controls.filter((s) => s.result.alerts.some((a) => atLeast(a, DELIVERY_MIN_TIER)));
  const controlAlerts = controls.reduce((n, s) => n + s.result.alerts.filter((a) => atLeast(a, DELIVERY_MIN_TIER)).length, 0);
  const controlDays = controls.reduce((d, s) => d + (Date.parse(s.testCase.newsAt) - Date.parse(s.testCase.windowStart)) / 86_400_000, 0);
  const insiderDelivered = insider.flatMap((s) => s.result.alerts.filter((a) => atLeast(a, DELIVERY_MIN_TIER)));
  return {
    insiderCases: insider.length,
    hits: insider.filter((s) => s.hit).length,
    medianLeadHours: median(insider.filter((s) => s.leadHours !== null).map((s) => s.leadHours!)),
    controls: controls.length,
    controlsWithAlert: controlHits.length,
    falsePositiveRate: controls.length ? controlHits.length / controls.length : null,
    controlAlertsPerDay: controlDays > 0 ? controlAlerts / controlDays : null,
    insiderWrongSideShare: insiderDelivered.length ? insiderDelivered.filter((a) => !a.winningSide).length / insiderDelivered.length : null,
  };
}

const fmtH = (h: number | null): string => (h === null ? '—' : `${h.toFixed(1)} h`);
const fmtUsd = (v: number): string => `$${Math.round(v).toLocaleString('en-US')}`;
const iso = (s: number): string => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');

export function renderMarkdown(
  summaries: CaseSummary[],
  meta: { generatedAt: string; configPath: string; variants?: { label: string; summaries: CaseSummary[] }[] },
): string {
  const t = totals(summaries);
  const lines: string[] = [];
  lines.push('# M2 backtest: omen signals on reported Polymarket insider cases');
  lines.push('');
  lines.push(`Generated ${meta.generatedAt} by \`omen backtest\` (config \`${meta.configPath}\`). Offline replay: no DB, Redis, Telegram, feed or Alchemy.`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push(`- Insider cases: **${t.hits}/${t.insiderCases} hit** (a delivered ${DELIVERY_MIN_TIER}+ alert on the winning side before the news).`);
  lines.push(`- Median lead time of the first such alert: **${fmtH(t.medianLeadHours)}**.`);
  lines.push(
    `- False-positive rate on controls: **${t.controlsWithAlert}/${t.controls}` +
      `${t.falsePositiveRate === null ? '' : ` (${(t.falsePositiveRate * 100).toFixed(0)}%)`}** of control markets had ≥1 delivered ${DELIVERY_MIN_TIER}+ alert; ` +
      `${t.controlAlertsPerDay === null ? '—' : t.controlAlertsPerDay.toFixed(2)} such alerts per control market-day.`,
  );
  lines.push(
    `- In the insider markets, ${t.insiderWrongSideShare === null ? '—' : `${(t.insiderWrongSideShare * 100).toFixed(0)}%`} of delivered ${DELIVERY_MIN_TIER}+ alerts were on the losing side.`,
  );
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('- **Data.** Polymarket data-api `/trades` (taker side, the feed omen ingests live) for each market from `windowStart − 24h` to the news cut-off, paged backwards by `end`; gamma `/markets` for metadata; data-api `/activity` (≤ 500 rows per page) for each wallet with a fill ≥ $250 (the lowest offline signal minimum). All responses cached under `.backtest-cache/`; reruns with `--offline` make no requests. No Alchemy calls, no Postgres/Redis, nothing sent to Telegram or the feed.');
  lines.push('- **Replay.** Each candidate fill goes through the live path: `evaluateLiveSignals` → market-maker filter (`calculateMarketMakerScore` ≥ `market_maker.min_score`) → `computeCompositeLiveScore` → `deriveAlertTier` → 24 h per wallet+market dedup (re-alert on +`dedup_score_increase`). Thresholds come from `omen.config.toml` as committed.');
  lines.push('- **Point-in-time inputs.** Market 24 h volume = the tape over the 24 h before each fill (gamma `volume24hr` has no history). Wallet totals, fill count, markets and market-maker score come from the wallet\'s Polymarket activity strictly before the fill. Wallet age = time since its first Polymarket activity (stand-in for the Alchemy first-transfer age; funding usually precedes the first trade by minutes to hours, so this reads slightly *fresher* than live). When the activity pages cannot see a fill\'s full prior history the wallet gets omen\'s conservative profile (fresh-wallet, lump and conviction cannot fire), as live does on a degraded profile.');
  lines.push('- **Not evaluated.** `SYBIL_CLUSTER` (needs Alchemy funding graphs) is off in the replay, so cluster-style cases (Iran Feb 28, ceasefire Apr 7) are scored without it.');
  lines.push(`- **Scoring.** Hit = a delivered ${DELIVERY_MIN_TIER}+ alert (the Telegram tiers) on the side that won, before the news cut-off. Lead = news − first such alert. FP rate = control markets with ≥ 1 delivered ${DELIVERY_MIN_TIER}+ alert. LOW alerts are promoted to the feed for grading but not delivered, so they count in the tier columns only.`);
  lines.push('- **Cut-offs.** News times are the first public signal from the linked reporting (UTC), rounded; see each case. Controls use a same-length window before expiry.');
  lines.push('');
  lines.push('## Per case');
  lines.push('');
  lines.push('| Case | Kind | Window trades / volume | Hit | Best winning-side tier | Lead (first hit) | Lead (first any alert) | Delivered alerts by tier (C/H/M/L) | Signals fired | Reported wallet flagged |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    const c = s.tierCounts;
    const sig = Object.entries(s.signalsFired).map(([k, v]) => `${k}×${v}`).join(', ') || '—';
    const rep = s.reportedWalletFlagged === null ? (s.testCase.reportedWallets?.length ? 'not found in tape' : 'n/a') : s.reportedWalletFlagged ? 'yes' : 'no';
    lines.push(
      `| ${s.testCase.id} | ${s.testCase.kind} | ${s.result.tradesInWindow.toLocaleString('en-US')} / ${fmtUsd(s.result.volumeInWindowUsd)} | ` +
        `${s.testCase.kind === 'insider' ? (s.hit ? '**HIT**' : 'miss') : s.result.alerts.some((a) => atLeast(a, DELIVERY_MIN_TIER)) ? 'FP' : 'clean'} | ` +
        `${s.bestWinningTier} | ${fmtH(s.leadHours)} | ${fmtH(s.firstAnyAlertLeadHours)} | ${c.CRITICAL}/${c.HIGH}/${c.MEDIUM}/${c.LOW} | ${sig} | ${rep} |`,
    );
  }
  lines.push('');
  for (const v of meta.variants ?? []) {
    const vt = totals(v.summaries);
    lines.push(`### What-if (not shipped): ${v.label}`);
    lines.push('');
    lines.push(
      `Hits **${vt.hits}/${vt.insiderCases}**, median lead ${fmtH(vt.medianLeadHours)}, controls with a ${DELIVERY_MIN_TIER}+ alert ` +
        `**${vt.controlsWithAlert}/${vt.controls}** (${vt.controlAlertsPerDay === null ? '—' : vt.controlAlertsPerDay.toFixed(2)}/market-day), ` +
        `losing-side share in insider markets ${vt.insiderWrongSideShare === null ? '—' : `${(vt.insiderWrongSideShare * 100).toFixed(0)}%`}.`,
    );
    lines.push('');
    lines.push('| Case | Hit | Best winning-side tier | Lead (first hit) | Delivered MEDIUM+ (winning / losing) |');
    lines.push('|---|---|---|---|---|');
    for (const s of v.summaries) {
      const m = s.result.alerts.filter((a) => atLeast(a, DELIVERY_MIN_TIER));
      lines.push(
        `| ${s.testCase.id} | ${s.testCase.kind === 'insider' ? (s.hit ? '**HIT**' : 'miss') : m.length ? 'FP' : 'clean'} | ${s.bestWinningTier} | ${fmtH(s.leadHours)} | ` +
          `${m.filter((a) => a.winningSide).length} / ${m.filter((a) => !a.winningSide).length} |`,
      );
    }
    lines.push('');
  }
  lines.push('### What-if probe (not shipped): fresh wallet (< 24 h, ≤ max_txns) longshot (< 0.30) at any market size');
  lines.push('');
  lines.push('Counts of probe fills before the news, winning side / losing side, by minimum stake. Lead = news minus first winning-side probe fill.');
  lines.push('');
  const stakes = [2_500, 5_000, 10_000];
  lines.push(`| Case | ${stakes.map((x) => `≥ ${fmtUsd(x)} (win / lose, lead)`).join(' | ')} |`);
  lines.push(`|---|${stakes.map(() => '---').join('|')}|`);
  for (const s of summaries) {
    const newsAt = Date.parse(s.testCase.newsAt) / 1000;
    const cells = stakes.map((min) => {
      const f = s.result.probeFills.filter((p) => p.stakeUsd >= min);
      const win = f.filter((p) => p.winningSide);
      const lead = win.length ? (newsAt - Math.min(...win.map((p) => p.timestamp))) / 3600 : null;
      return `${win.length} / ${f.length - win.length}${lead === null ? '' : `, ${lead.toFixed(1)} h`}`;
    });
    lines.push(`| ${s.testCase.id} (${s.testCase.kind}) | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Case details');
  for (const s of summaries) {
    lines.push('');
    lines.push(`### ${s.testCase.id}: ${s.testCase.title}`);
    lines.push('');
    lines.push(`- Condition \`${s.testCase.conditionId}\`; winner ${s.testCase.winningOutcome}.`);
    lines.push(`- Window ${s.testCase.windowStart} → news ${s.testCase.newsAt} (${s.testCase.newsNote}).`);
    lines.push(
      `- ${s.result.candidatesEvaluated} candidate fills evaluated; ${s.result.walletsProfiled} wallets profiled from Polymarket activity` +
        `${s.result.walletsUnprofiled ? `, ${s.result.walletsUnprofiled} over the profiling cap (conservative profile)` : ''}.`,
    );
    lines.push(`- Sources: ${s.testCase.sources.map((x) => `[${x.label}](${x.url})`).join('; ')}`);
    if (s.result.reportedFills.length > 0) {
      const r = s.result.reportedFills;
      lines.push(`- Reported wallet fills in window: ${r.length} (${fmtUsd(r.reduce((n, f) => n + f.sizeUsd, 0))}); best tier ${r.reduce<AlertTier>((b, f) => (TIER_RANK[f.tier] > TIER_RANK[b] ? f.tier : b), 'CLEAN')}.`);
    }
    const top = [...s.result.alerts]
      .filter((a) => a.delivered && TIER_RANK[a.tier] >= TIER_RANK.LOW)
      .sort((a, b) => b.score - a.score || a.timestamp - b.timestamp)
      .slice(0, 5);
    if (top.length > 0) {
      lines.push('');
      lines.push('| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |');
      lines.push('|---|---|---|---|---|---|---|---|');
      for (const a of top) {
        lines.push(
          `| ${iso(a.timestamp)} | ${a.name ?? a.wallet.slice(0, 10)} | ${a.effectiveOutcome}${a.winningSide ? ' ✓' : ''} @ ${a.effectivePrice.toFixed(3)} | ${fmtUsd(a.sizeUsd)} | ${fmtUsd(a.marketDailyVolumeUsd)} | ` +
            `${a.walletAgeHours === null ? '?' : `${a.walletAgeHours.toFixed(1)} h`} | ${a.score} / ${a.tier} | ${a.signals.join(', ')} |`,
        );
      }
    }
  }
  return lines.join('\n');
}
