import { describe, expect, it, vi } from 'vitest';
import { formatExclusionShare, summarizeExclusionShare } from '../../../src/markets/exclusion-share.js';
import { bumpMarketExclusion, marketExclusionStatsKey, readMarketExclusions } from '../../../src/markets/exclusion-stats.js';
import { extractCategory, extractTags } from '../../../src/phase0/public-api.js';

describe('summarizeExclusionShare', () => {
  it('splits fills and alerts by exclusion class', () => {
    const rows = [
      { marketId: 'sport', fills: 60, fillUsd: 6_000, alerts: 6, dispatchEligibleAlerts: 3 },
      { marketId: 'politics', fills: 30, fillUsd: 3_000, alerts: 3, dispatchEligibleAlerts: 1 },
      { marketId: 'gone', fills: 10, fillUsd: 1_000, alerts: 1, dispatchEligibleAlerts: 0 },
    ];
    const report = summarizeExclusionShare(rows, (id) =>
      id === 'sport' ? { category: 'sports', source: 'metadata' } : id === 'politics' ? null : undefined,
    );
    expect(report.total).toEqual({ markets: 3, fills: 100, fillUsd: 10_000, alerts: 10, dispatchEligibleAlerts: 4 });
    expect(report.byClass['sports:metadata']).toMatchObject({ fills: 60, alerts: 6 });
    expect(report.byClass.kept).toMatchObject({ fills: 30 });
    expect(report.byClass.unknown).toMatchObject({ fills: 10 });
    expect(formatExclusionShare(report)).toContain('60 (60.0%)');
  });
});

describe('market exclusion stats', () => {
  it('counts exclusions per UTC day by category and source', async () => {
    const hash = new Map<string, number>();
    const redis = {
      hincrby: vi.fn(async (_key: string, field: string, by: number) => {
        hash.set(field, (hash.get(field) ?? 0) + by);
        return hash.get(field)!;
      }),
      expire: vi.fn(async () => 1),
      hgetall: vi.fn(async () => Object.fromEntries([...hash].map(([k, v]) => [k, String(v)]))),
    };
    const now = new Date('2026-10-19T12:00:00Z');
    await bumpMarketExclusion(redis as never, { category: 'sports', source: 'metadata' }, now);
    await bumpMarketExclusion(redis as never, { category: 'sports', source: 'heuristic' }, now);
    expect(redis.hincrby).toHaveBeenCalledWith(marketExclusionStatsKey(now), 'sports', 1);
    expect(marketExclusionStatsKey(now)).toBe('omen:hot:market-excluded:2026-10-19');
    expect(await readMarketExclusions(redis as never, now)).toEqual({ sports: 2, 'sports:metadata': 1, 'sports:heuristic': 1 });
  });
});

describe('Gamma metadata mapping', () => {
  it('extracts tags (market + event, slug + label, series) and category', () => {
    const market = {
      category: 'Sports',
      tags: [{ slug: 'soccer', label: 'Soccer' }],
      events: [{ seriesSlug: 'serie-a-2025', tags: [{ slug: 'sports', label: 'Sports' }] }],
    };
    expect(extractTags(market)).toEqual(['soccer', 'sports', 'series:serie-a-2025']);
    expect(extractCategory(market)).toBe('Sports');
    expect(extractCategory({ events: [{ category: 'Politics' }] })).toBe('Politics');
    expect(extractTags({})).toEqual([]);
  });
});
