import type { MarketInfo } from '../types/market.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function marketHaystack(market: Pick<MarketInfo, 'eventSlug' | 'marketSlug' | 'question'>): string {
  return [market.eventSlug, market.marketSlug, market.question]
    .filter((s): s is string => s !== null)
    .map((s) => s.toLowerCase())
    .join(' ');
}

function matchesAnyKeyword(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`).test(haystack));
}

export function isMarketExcluded(
  market: MarketInfo,
  excludedCategories: Record<string, string[]>,
): boolean {
  const haystack = marketHaystack(market);
  return Object.values(excludedCategories).some((keywords) => matchesAnyKeyword(haystack, keywords));
}

export type MarketExclusionSource = 'metadata' | 'heuristic' | 'keyword';

export interface MarketExclusion {
  category: string;
  source: MarketExclusionSource;
}

const SPORTS_CATEGORY = /\b(sports?|e-?sports)\b/i;
// Gamma tag slugs/labels that only appear on sports markets (every Gamma sports market also carries `sports`).
const SPORTS_TAGS = new Set([
  'sports',
  'esports',
  'soccer',
  'football',
  'basketball',
  'baseball',
  'hockey',
  'tennis',
  'cricket',
  'golf',
  'rugby',
  'boxing',
  'mma',
  'ufc',
  'f1',
  'formula 1',
  'formula-1',
  'nfl',
  'nba',
  'mlb',
  'nhl',
  'wnba',
  'ncaa',
  'cfb',
  'cbb',
  'epl',
  'premier-league',
  'la-liga',
  'serie-a',
  'bundesliga',
  'ligue-1',
  'champions-league',
  'counter-strike-2',
  'league-of-legends',
  'dota-2',
  'valorant',
]);

// Fallback only (no Gamma/Kalshi metadata): shapes of game markets the keyword list misses.
const SPORTS_HEURISTIC_PATTERNS = [
  /\bwin on \d{4}-\d{2}-\d{2}\b/,
  /\bend in a draw\b/,
  /\bdraw\?/,
  /\bexact score\b/,
  /\b(o\/u|over\/under|spread:|moneyline)\b/,
  /\svs\.?\s/,
  /\(bo[1357]\)/,
  /\b(counter-strike|dota 2|league of legends|valorant|lck|lpl|lec|iem|esl pro league|blast premier|pgl)\b/,
];

/** True when the market carries any Gamma classification (category, tags or sportsMarketType). */
export function hasMarketMetadata(market: Pick<MarketInfo, 'category' | 'tags' | 'sportsMarketType'>): boolean {
  return Boolean(market.category) || (market.tags?.length ?? 0) > 0 || Boolean(market.sportsMarketType);
}

export function isSportsByMetadata(market: Pick<MarketInfo, 'category' | 'tags' | 'sportsMarketType'>): boolean {
  if (market.sportsMarketType) return true;
  if (market.category && SPORTS_CATEGORY.test(market.category)) return true;
  return (market.tags ?? []).some((tag) => SPORTS_TAGS.has(tag.toLowerCase()));
}

export function isSportsByHeuristic(
  market: Pick<MarketInfo, 'eventSlug' | 'marketSlug' | 'question'>,
  keywords: string[] = [],
): boolean {
  const haystack = marketHaystack(market);
  return matchesAnyKeyword(haystack, keywords) || SPORTS_HEURISTIC_PATTERNS.some((pattern) => pattern.test(haystack));
}

export interface MarketExclusionConfig {
  /** detection.excluded_categories: keyword lists by category name (weather, sports, ...). */
  keywordCategories: Record<string, string[]>;
  /**
   * filters.exclude_categories. Categories here with a metadata classifier (sports) are decided by Gamma metadata
   * first; their keyword list (plus game-shaped patterns) is only a fallback when the market has no metadata.
   * null = legacy keyword-only matching for every keyword category.
   */
  excludeCategories: string[] | null;
}

const METADATA_CLASSIFIERS: Record<string, (market: MarketInfo) => boolean> = {
  sports: isSportsByMetadata,
};

const HEURISTIC_CLASSIFIERS: Record<string, (market: MarketInfo, keywords: string[]) => boolean> = {
  sports: isSportsByHeuristic,
};

/** Why a market is excluded from signals (first matching category), or null. */
export function classifyMarketExclusion(market: MarketInfo, config: MarketExclusionConfig): MarketExclusion | null {
  const filters = config.excludeCategories;
  if (filters !== null) {
    const withMetadata = hasMarketMetadata(market);
    for (const category of filters) {
      const byMetadata = METADATA_CLASSIFIERS[category];
      if (!byMetadata) continue;
      if (withMetadata) {
        if (byMetadata(market)) return { category, source: 'metadata' };
      } else if (HEURISTIC_CLASSIFIERS[category]?.(market, config.keywordCategories[category] ?? [])) {
        return { category, source: 'heuristic' };
      }
    }
  }

  const haystack = marketHaystack(market);
  for (const [category, keywords] of Object.entries(config.keywordCategories)) {
    // Metadata-classified categories are handled above (and are off when absent from filters).
    if (filters !== null && METADATA_CLASSIFIERS[category]) continue;
    if (matchesAnyKeyword(haystack, keywords)) return { category, source: 'keyword' };
  }
  return null;
}
