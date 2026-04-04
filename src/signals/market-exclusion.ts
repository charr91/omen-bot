import type { MarketInfo } from '../types/market.js';

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
      if (haystack.includes(keyword.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}
