import type { BacktestCase } from './cases.js';
import { TIER_RANK, type ReplayAlert, type ReplayResult } from './replay.js';
import type { AlertTier } from '../types/signal.js';
import type { Horizon, MoveStat } from './moves.js';

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

/**
 * Reaches Telegram: passes the dedup, tier >= `tier`, and carries at least one deliverable signal (score-only
 * NICHE/OUTSIZED/LUMP and shadow signals lift the tier but never deliver their own alert).
 */
function atLeast(alert: ReplayAlert, tier: AlertTier, signalId?: string): boolean {
  const deliverable = (alert.deliverableSignals ?? alert.signals) as string[];
  return (
    alert.delivered &&
    TIER_RANK[alert.tier] >= TIER_RANK[tier] &&
    (signalId === undefined ? deliverable.length > 0 : deliverable.includes(signalId))
  );
}

export function summarizeCase(testCase: BacktestCase, result: ReplayResult, minTier: AlertTier = DELIVERY_MIN_TIER): CaseSummary {
  const newsAt = Date.parse(testCase.newsAt) / 1000;
  const delivered = result.alerts.filter((a) => a.delivered);
  const winning = delivered.filter((a) => a.winningSide && atLeast(a, minTier));
  // `delivered` below = alerts that passed the dedup (any tier, for the tier columns).
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
  flaggedCases: number;
  hits: number;
  medianLeadHours: number | null;
  controls: number;
  controlsWithAlert: number;
  /** Controls with >= 1 delivered MEDIUM+ alert / controls. */
  falsePositiveRate: number | null;
  controlAlertsPerDay: number | null;
  /** Share of delivered MEDIUM+ alerts in flagged (public-report) markets that were on the losing side. */
  flaggedWrongSideShare: number | null;
}

export function totals(summaries: CaseSummary[]): BacktestTotals {
  const flagged = summaries.filter((s) => s.testCase.kind === 'flagged');
  const controls = summaries.filter((s) => s.testCase.kind === 'control');
  const controlHits = controls.filter((s) => s.result.alerts.some((a) => atLeast(a, DELIVERY_MIN_TIER)));
  const controlAlerts = controls.reduce((n, s) => n + s.result.alerts.filter((a) => atLeast(a, DELIVERY_MIN_TIER)).length, 0);
  const controlDays = controls.reduce((d, s) => d + (Date.parse(s.testCase.newsAt) - Date.parse(s.testCase.windowStart)) / 86_400_000, 0);
  const flaggedDelivered = flagged.flatMap((s) => s.result.alerts.filter((a) => atLeast(a, DELIVERY_MIN_TIER)));
  return {
    flaggedCases: flagged.length,
    hits: flagged.filter((s) => s.hit).length,
    medianLeadHours: median(flagged.filter((s) => s.leadHours !== null).map((s) => s.leadHours!)),
    controls: controls.length,
    controlsWithAlert: controlHits.length,
    falsePositiveRate: controls.length ? controlHits.length / controls.length : null,
    controlAlertsPerDay: controlDays > 0 ? controlAlerts / controlDays : null,
    flaggedWrongSideShare: flaggedDelivered.length ? flaggedDelivered.filter((a) => !a.winningSide).length / flaggedDelivered.length : null,
  };
}

const fmtH = (h: number | null): string => (h === null ? '—' : `${h.toFixed(1)} h`);
const fmtUsd = (v: number): string => `$${Math.round(v).toLocaleString('en-US')}`;
const iso = (s: number): string => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');

export function renderMarkdown(
  summaries: CaseSummary[],
  meta: {
    generatedAt: string;
    configPath: string;
    variants?: { label: string; summaries: CaseSummary[] }[];
    /** Signals whose alerts reach Telegram under this config (scorecard rows). */
    deliveredSignals?: string[];
    moves?: MovesReport;
  },
): string {
  const t = totals(summaries);
  const lines: string[] = [];
  lines.push('# M2 backtest: omen signals on public-report Polymarket cases');
  lines.push('');
  lines.push(`Generated ${meta.generatedAt} by \`omen backtest\` (config \`${meta.configPath}\`). Offline replay: no DB, Redis, Telegram, feed or Alchemy.`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push(`- Flagged (public-report) cases: **${t.hits}/${t.flaggedCases} hit** (a delivered ${DELIVERY_MIN_TIER}+ alert from a deliverable signal on the winning side before the news).`);
  lines.push(`- Median lead time of the first such alert: **${fmtH(t.medianLeadHours)}**.`);
  lines.push(
    `- False-positive rate on controls: **${t.controlsWithAlert}/${t.controls}` +
      `${t.falsePositiveRate === null ? '' : ` (${(t.falsePositiveRate * 100).toFixed(0)}%)`}** of control markets had ≥1 delivered ${DELIVERY_MIN_TIER}+ alert; ` +
      `${t.controlAlertsPerDay === null ? '—' : t.controlAlertsPerDay.toFixed(2)} such alerts per control market-day.`,
  );
  lines.push(
    `- In the flagged markets, ${t.flaggedWrongSideShare === null ? '—' : `${(t.flaggedWrongSideShare * 100).toFixed(0)}%`} of delivered ${DELIVERY_MIN_TIER}+ alerts were on the losing side.`,
  );
  lines.push('');
  if (meta.deliveredSignals?.length) lines.push(...renderScorecard(meta.deliveredSignals, summaries));
  lines.push('## Method');
  lines.push('');
  lines.push('- **Data.** Polymarket data-api `/trades` (taker side, the feed omen ingests live) for each market from `windowStart − 24h` to the news cut-off, paged backwards by `end`; gamma `/markets` for metadata; data-api `/activity` (≤ 500 rows per page) for each wallet with a fill ≥ $250 (the lowest offline signal minimum). All responses cached under `.backtest-cache/`; reruns with `--offline` make no requests. No Alchemy calls, no Postgres/Redis, nothing sent to Telegram or the feed.');
  lines.push('- **Replay.** Each candidate fill goes through the live path: `evaluateLiveSignals` (including the sports/weather market exclusion on Gamma metadata) → market-maker filter (`calculateMarketMakerScore` ≥ `market_maker.min_score`) → `computeDeliverableLiveScore` (score-only signals count, shadow signals do not) → `deriveAlertTier` → 24 h per wallet+market dedup (re-alert on +`dedup_score_increase`). Thresholds come from `omen.config.toml` as committed.');
  lines.push('- **Point-in-time inputs.** Market 24 h volume = the tape over the 24 h before each fill (gamma `volume24hr` has no history). Wallet totals, fill count, markets and market-maker score come from the wallet\'s Polymarket activity strictly before the fill. Wallet age = time since its first Polymarket activity (stand-in for the Alchemy first-transfer age; funding usually precedes the first trade by minutes to hours, so this reads slightly *fresher* than live). When the activity pages cannot see a fill\'s full prior history the wallet gets omen\'s conservative profile (fresh-wallet, lump and conviction cannot fire), as live does on a degraded profile. Wallets beyond `--max-wallets` per case (largest fills first) also get the conservative profile.');
  lines.push('- **Not evaluated.** `SYBIL_CLUSTER` (needs Alchemy funding graphs; muted on Telegram anyway) is off in the replay, so cluster-style cases (Iran Feb 28, ceasefire Apr 7) are scored without it.');
  lines.push(`- **Scoring.** Live delivery is per (fill, signal): a signal\'s own alert reaches Telegram when it is deliverable (not score-only, not shadow) and the fill\'s deliverable tier is ${DELIVERY_MIN_TIER}+ (the feed sends MEDIUM+; LOW is dry-run). Hit = such an alert on the side that won, before the news cut-off. Lead = news − first such alert. FP = control market with ≥ 1 such alert. The tier columns count every dedup-passing alert, delivered or not.`);
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
        `${s.testCase.kind === 'flagged' ? (s.hit ? '**HIT**' : 'miss') : s.result.alerts.some((a) => atLeast(a, DELIVERY_MIN_TIER)) ? 'FP' : 'clean'} | ` +
        `${s.bestWinningTier} | ${fmtH(s.leadHours)} | ${fmtH(s.firstAnyAlertLeadHours)} | ${c.CRITICAL}/${c.HIGH}/${c.MEDIUM}/${c.LOW} | ${sig} | ${rep} |`,
    );
  }
  lines.push('');
  for (const v of meta.variants ?? []) {
    const vt = totals(v.summaries);
    lines.push(`### What-if (not shipped): ${v.label}`);
    lines.push('');
    lines.push(
      `Hits **${vt.hits}/${vt.flaggedCases}**, median lead ${fmtH(vt.medianLeadHours)}, controls with a ${DELIVERY_MIN_TIER}+ alert ` +
        `**${vt.controlsWithAlert}/${vt.controls}** (${vt.controlAlertsPerDay === null ? '—' : vt.controlAlertsPerDay.toFixed(2)}/market-day), ` +
        `losing-side share in flagged markets ${vt.flaggedWrongSideShare === null ? '—' : `${(vt.flaggedWrongSideShare * 100).toFixed(0)}%`}.`,
    );
    lines.push('');
    lines.push('| Case | Hit | Best winning-side tier | Lead (first hit) | Delivered MEDIUM+ (winning / losing) |');
    lines.push('|---|---|---|---|---|');
    for (const s of v.summaries) {
      const m = s.result.alerts.filter((a) => atLeast(a, DELIVERY_MIN_TIER));
      lines.push(
        `| ${s.testCase.id} | ${s.testCase.kind === 'flagged' ? (s.hit ? '**HIT**' : 'miss') : m.length ? 'FP' : 'clean'} | ${s.bestWinningTier} | ${fmtH(s.leadHours)} | ` +
          `${m.filter((a) => a.winningSide).length} / ${m.filter((a) => !a.winningSide).length} |`,
      );
    }
    lines.push('');
  }
  if (meta.moves) lines.push(...renderMoves(meta.moves));
  lines.push('## Case details');
  for (const s of summaries) {
    lines.push('');
    lines.push(`### ${s.testCase.id}: ${s.testCase.title}`);
    lines.push('');
    lines.push(`- Condition \`${s.testCase.conditionId}\`; winner ${s.testCase.winningOutcome}.`);
    lines.push(`- Window ${s.testCase.windowStart} → news ${s.testCase.newsAt} (${s.testCase.newsNote}).`);
    if (s.result.excludedMarket) lines.push('- **Excluded market** (sports/weather filter): no signals can fire, as live.');
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


export interface SignalScorecard {
  signalId: string;
  flaggedCases: number;
  hits: number;
  medianLeadHours: number | null;
  /** Delivered MEDIUM+ alerts carrying the signal in flagged (public-report) markets: winning / losing side. */
  flaggedWinningAlerts: number;
  flaggedLosingAlerts: number;
  controls: number;
  controlsWithAlert: number;
  controlAlerts: number;
  controlAlertsPerDay: number | null;
}

/** One delivered signal's record: its own delivered MEDIUM+ alerts (the alert carries the signal and passes dedup). */
export function signalScorecard(signalId: string, summaries: CaseSummary[]): SignalScorecard {
  const leads: number[] = [];
  let hits = 0;
  let flaggedWinningAlerts = 0;
  let flaggedLosingAlerts = 0;
  let controlsWithAlert = 0;
  let controlAlerts = 0;
  let controlDays = 0;
  for (const s of summaries) {
    const fired = s.result.alerts.filter((a) => atLeast(a, DELIVERY_MIN_TIER, signalId));
    const win = fired.filter((a) => a.winningSide);
    if (s.testCase.kind === 'flagged') {
      flaggedWinningAlerts += win.length;
      flaggedLosingAlerts += fired.length - win.length;
      if (win.length) {
        hits += 1;
        leads.push((Date.parse(s.testCase.newsAt) / 1000 - Math.min(...win.map((a) => a.timestamp))) / 3600);
      }
    } else {
      controlDays += (Date.parse(s.testCase.newsAt) - Date.parse(s.testCase.windowStart)) / 86_400_000;
      controlAlerts += fired.length;
      if (fired.length) controlsWithAlert += 1;
    }
  }
  return {
    signalId,
    flaggedCases: summaries.filter((s) => s.testCase.kind === 'flagged').length,
    hits,
    medianLeadHours: median(leads),
    flaggedWinningAlerts,
    flaggedLosingAlerts,
    controls: summaries.filter((s) => s.testCase.kind === 'control').length,
    controlsWithAlert,
    controlAlerts,
    controlAlertsPerDay: controlDays > 0 ? controlAlerts / controlDays : null,
  };
}

function renderScorecard(signalIds: string[], summaries: CaseSummary[]): string[] {
  const t = totals(summaries);
  const lines: string[] = [];
  lines.push('## Per delivered signal');
  lines.push('');
  lines.push(
    `A signal's own alert is delivered when it passes the dedup, the fill's deliverable score is ${DELIVERY_MIN_TIER}+ and the signal is neither score-only nor shadow. ` +
      'Hit = such an alert on the winning side before the news; FP = a control market with one.',
  );
  lines.push('');
  lines.push('| Signal | Flagged hits | Median lead (first hit) | Flagged alerts (winning / losing) | Controls with alert (FP) | Control alerts / market-day |');
  lines.push('|---|---|---|---|---|---|');
  for (const id of signalIds) {
    const c = signalScorecard(id, summaries);
    lines.push(
      `| ${id} | ${c.hits}/${c.flaggedCases} | ${fmtH(c.medianLeadHours)} | ${c.flaggedWinningAlerts} / ${c.flaggedLosingAlerts} | ` +
        `${c.controlsWithAlert}/${c.controls} | ${c.controlAlertsPerDay === null ? '—' : c.controlAlertsPerDay.toFixed(2)} |`,
    );
  }
  lines.push(
    `| **any delivered** | **${t.hits}/${t.flaggedCases}** | ${fmtH(t.medianLeadHours)} | — | **${t.controlsWithAlert}/${t.controls}** | ${t.controlAlertsPerDay === null ? '—' : t.controlAlertsPerDay.toFixed(2)} |`,
  );
  lines.push('');
  return lines;
}

export interface MovesCell {
  signal: MoveStat;
  base: MoveStat;
  edge: number | null;
}

export interface MovesReport {
  /** Rows: signal × scope ('fired' = every firing, as live grades; 'delivered' = delivered MEDIUM+ alerts) × subset. */
  rows: { signalId: string; scope: 'fired' | 'delivered'; subset: 'all' | 'flagged' | 'control'; cells: Record<Horizon, MovesCell> }[];
  baselineFills: number;
}

const cents = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}¢`);
const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

function renderMoves(m: MovesReport): string[] {
  const lines: string[] = [];
  lines.push('## Average price move vs the same-market, same-band baseline');
  lines.push('');
  lines.push(
    'Same frame as `omen stats` (M1 outcomes): directional move of the traded token (BUY gains when it rises) in cents at +1 h, +24 h and resolution; ' +
      'flat moves are left out of n and the averages. Baseline = candidate fills (≥ the lowest signal minimum) with no signal and no market-maker wallet, ' +
      `**in the same market and the same 20¢ effective entry-price band**, weighted by the signal's fills per (market, band) cell (${m.baselineFills.toLocaleString('en-US')} baseline fills). ` +
      'Prices come from the public tape (last trade at or before the horizon; resolution price once the market closed), not CLOB mid history as live. ' +
      '"fired" = every firing of the signal at any tier (what live grades); "delivered" = its delivered MEDIUM+ alerts.',
  );
  lines.push('');
  lines.push('| Signal | Scope | Cases | n (+1h / +24h / res) | +1h signal / base / edge | +24h signal / base / edge | Resolution signal / base / edge | Hit rate +24h (signal / base) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of m.rows) {
    const c = r.cells;
    const cell = (x: MovesCell) => `${cents(x.signal.avg)} / ${cents(x.base.avg)} / **${cents(x.edge)}**`;
    lines.push(
      `| ${r.signalId} | ${r.scope} | ${r.subset} | ${c.h1.signal.n} / ${c.h24.signal.n} / ${c.resolution.signal.n} | ${cell(c.h1)} | ${cell(c.h24)} | ${cell(c.resolution)} | ` +
        `${pct(c.h24.signal.hitRate)} / ${pct(c.h24.base.hitRate)} |`,
    );
  }
  lines.push('');
  return lines;
}

export const FINDINGS_START = '<!-- findings:start (hand-written; `omen backtest` keeps this block) -->';
export const FINDINGS_END = '<!-- findings:end -->';

/**
 * Appends the hand-written Findings block from the previous report to freshly generated markdown. The block is the
 * text between FINDINGS_START/FINDINGS_END; a legacy report without markers keeps everything from its
 * `## Findings` heading on. With no previous findings, an empty marker block is added for the next edit.
 */
export function mergeFindings(generated: string, previous: string | null): string {
  let findings: string | null = null;
  if (previous) {
    const start = previous.indexOf(FINDINGS_START);
    const end = previous.indexOf(FINDINGS_END);
    if (start >= 0 && end > start) {
      findings = previous.slice(start + FINDINGS_START.length, end).trim();
    } else {
      const heading = previous.search(/^## Findings/m);
      if (heading >= 0) findings = previous.slice(heading).trim();
    }
  }
  return `${generated.trimEnd()}\n\n${FINDINGS_START}\n${findings ? `${findings}\n` : ''}${FINDINGS_END}`;
}
