import { loadAppConfig } from '../config/index.js';
import { createDbPool } from '../persistence/db.js';
import { fetchMarketsByConditionIds } from '../phase0/public-api.js';
import { marketExclusionConfig } from '../signals/evaluate-live-signals.js';
import { classifyMarketExclusion, type MarketExclusion } from '../signals/market-exclusion.js';
import type { MarketInfo } from '../types/market.js';
import { toMarketInfo } from './catalog.js';

export interface MarketActivityRow {
  marketId: string;
  fills: number;
  fillUsd: number;
  alerts: number;
  dispatchEligibleAlerts: number;
}

export interface ExclusionShareBucket {
  markets: number;
  fills: number;
  fillUsd: number;
  alerts: number;
  dispatchEligibleAlerts: number;
}

export interface ExclusionShareReport {
  total: ExclusionShareBucket;
  /** Keyed by `<category>:<source>` (e.g. sports:metadata), `kept`, or `unknown` (market not found on Gamma). */
  byClass: Record<string, ExclusionShareBucket>;
}

function emptyBucket(): ExclusionShareBucket {
  return { markets: 0, fills: 0, fillUsd: 0, alerts: 0, dispatchEligibleAlerts: 0 };
}

function addTo(bucket: ExclusionShareBucket, row: MarketActivityRow): void {
  bucket.markets += 1;
  bucket.fills += row.fills;
  bucket.fillUsd += row.fillUsd;
  bucket.alerts += row.alerts;
  bucket.dispatchEligibleAlerts += row.dispatchEligibleAlerts;
}

export function summarizeExclusionShare(
  rows: MarketActivityRow[],
  classify: (marketId: string) => MarketExclusion | null | undefined,
): ExclusionShareReport {
  const report: ExclusionShareReport = { total: emptyBucket(), byClass: {} };
  for (const row of rows) {
    const exclusion = classify(row.marketId);
    const key = exclusion === undefined ? 'unknown' : exclusion === null ? 'kept' : `${exclusion.category}:${exclusion.source}`;
    addTo(report.total, row);
    addTo((report.byClass[key] ??= emptyBucket()), row);
  }
  return report;
}

function pct(part: number, total: number): string {
  return total > 0 ? `${((100 * part) / total).toFixed(1)}%` : '-';
}

export function formatExclusionShare(report: ExclusionShareReport): string {
  const t = report.total;
  const lines = [
    'class                    markets   fills (share)       fill USD (share)          alerts (share)   eligible (share)',
  ];
  for (const [key, b] of Object.entries(report.byClass).sort((a, b) => b[1].fills - a[1].fills)) {
    lines.push(
      [
        key.padEnd(24),
        String(b.markets).padStart(7),
        `${b.fills} (${pct(b.fills, t.fills)})`.padStart(17),
        `${Math.round(b.fillUsd)} (${pct(b.fillUsd, t.fillUsd)})`.padStart(24),
        `${b.alerts} (${pct(b.alerts, t.alerts)})`.padStart(16),
        `${b.dispatchEligibleAlerts} (${pct(b.dispatchEligibleAlerts, t.dispatchEligibleAlerts)})`.padStart(18),
      ].join(' '),
    );
  }
  lines.push(`total: ${t.markets} markets, ${t.fills} fills, $${Math.round(t.fillUsd)}, ${t.alerts} alerts, ${t.dispatchEligibleAlerts} dispatch-eligible`);
  return lines.join('\n');
}

const GAMMA_BATCH = 50;

async function fetchMarketInfo(marketIds: string[]): Promise<Map<string, MarketInfo>> {
  const out = new Map<string, MarketInfo>();
  for (const closed of [false, true]) {
    const missing = marketIds.filter((id) => !out.has(id));
    for (let i = 0; i < missing.length; i += GAMMA_BATCH) {
      for (const market of await fetchMarketsByConditionIds(missing.slice(i, i + GAMMA_BATCH), { closed })) {
        out.set(market.conditionId, toMarketInfo(market));
      }
    }
  }
  return out;
}

/**
 * omen sports-share [--days 7] [--json]: read-only. Share of Polymarket fills / alerts in the window that
 * [filters] exclude_categories would drop, classified from current Gamma metadata (one Gamma call per 50 markets).
 */
export async function runExclusionShareCommand(args: string[]): Promise<string> {
  let days = 7;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--days') days = Number(args[++i]);
    else throw new Error(`Unknown sports-share option: ${arg}`);
  }
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');

  const config = await loadAppConfig();
  const pool = createDbPool(config);
  try {
    const since = new Date(Date.now() - days * 86_400_000);
    const result = await pool.query<{ market_id: string; fills: string; fill_usd: string; alerts: string; eligible: string }>(
      `
        with f as (
          select market_id, count(*) as fills, coalesce(sum(size_usd), 0) as fill_usd
          from fills where timestamp >= $1 group by market_id
        ), a as (
          select market_id, count(*) as alerts, count(*) filter (where dispatch_eligible) as eligible
          from alerts where promoted_at >= $1 group by market_id
        )
        select coalesce(f.market_id, a.market_id) as market_id, coalesce(f.fills, 0)::text as fills,
          coalesce(f.fill_usd, 0)::text as fill_usd, coalesce(a.alerts, 0)::text as alerts, coalesce(a.eligible, 0)::text as eligible
        from f full outer join a on a.market_id = f.market_id
      `,
      [since],
    );
    const rows: MarketActivityRow[] = result.rows.map((r) => ({
      marketId: r.market_id,
      fills: Number(r.fills),
      fillUsd: Number(r.fill_usd),
      alerts: Number(r.alerts),
      dispatchEligibleAlerts: Number(r.eligible),
    }));
    const markets = await fetchMarketInfo(rows.map((r) => r.marketId));
    const exclusionConfig = marketExclusionConfig(config);
    const report = summarizeExclusionShare(rows, (id) => {
      const market = markets.get(id);
      return market === undefined ? undefined : classifyMarketExclusion(market, exclusionConfig);
    });
    if (json) return JSON.stringify({ since: since.toISOString(), filters: config.filters.excludeCategories, ...report }, null, 2);
    return [
      `omen sports-share: last ${days} day(s) since ${since.toISOString()}; filters.exclude_categories = ${JSON.stringify(config.filters.excludeCategories)}`,
      'Polymarket fills and promoted alerts by exclusion class (current Gamma metadata; kept = not excluded).',
      '',
      formatExclusionShare(report),
    ].join('\n');
  } finally {
    await pool.end();
  }
}
