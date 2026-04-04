import type { MarketInfo } from '../types/market.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isMarketExcluded(
  market: MarketInfo,
  excludedCategories: Record<string, string[]>,
): boolean {
  const haystack = [market.eventSlug, market.marketSlug, market.question]
    .filter((s): s is string => s !== null)
    .map((s) => s.toLowerCase())
    .join(' ');

  for (const keywords of Object.values(excludedCategories)) {
    for (const keyword of keywords) {
      const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`);
      if (pattern.test(haystack)) {
        return true;
      }
    }
  }

  return false;
}
