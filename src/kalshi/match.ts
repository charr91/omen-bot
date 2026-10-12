/** Polymarket <-> Kalshi candidate matching by title tokens, numbers and dates (for `omen kalshi-map suggest`). */

export interface PolymarketCandidate {
  conditionId: string;
  question: string;
  endDate: Date | null;
  outcomes: string[];
  volume24h: number;
}

export interface KalshiCandidate {
  ticker: string;
  title: string;
  yesSubTitle: string;
  eventDate: Date | null;
  volume24h: number;
}

export interface MatchSuggestion {
  polymarket: PolymarketCandidate;
  kalshi: KalshiCandidate;
  confidence: number;
  tokenSimilarity: number;
  numbersMatch: boolean;
  dateGapHours: number | null;
  /** Very-high-confidence exact match: safe to auto-add. */
  exact: boolean;
  conflicts: string[];
}

const STOPWORDS = new Set(
  'a an the will be is are was of in on at to by for and or vs v versus who what which win wins winner game match fc ' +
    'than over under more less above below before after end ends happen yes no market price on 2025 2026 2027 does do'.split(' '),
);
const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/;

export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.%$ ]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !MONTHS.test(t) && !/^\d+$/.test(t));
}

/** Numbers that change meaning (thresholds, spreads, counts). Years and day-of-month dates are excluded. */
export function extractNumbers(text: string): string[] {
  const withoutDates = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi, ' ')
    .replace(/\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*/gi, ' ');
  const numbers = withoutDates.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return [...new Set(numbers.map((n) => String(Number(n.replace(/,/g, '')))))].sort();
}

/** Words that change what is being asked; present on one side only => probably a different market. */
const QUALIFIERS = [
  'vice', 'first', '1st', 'anytime', 'most', 'host', 'runoff', 'second', 'round', 'nominee', 'nomination', 'primary',
  'margin', 'spread', 'total', 'seats', 'out', 'mention', 'say', 'rank', 'top', 'exactly', 'between', 'half', 'quarter',
  'popular', 'electoral', 'governor', 'senate', 'house', 'mayor',
];

const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Month-day mentions in a title ("October 13", "Oct 13, 2026", "2026-10-13") as "M-D" keys. */
export function extractMonthDays(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi)) {
    out.add(`${MONTH_INDEX[m[1]!.toLowerCase()]}-${Number(m[2])}`);
  }
  for (const m of text.matchAll(/\b\d{4}-(\d{2})-(\d{2})\b/g)) out.add(`${Number(m[1])}-${Number(m[2])}`);
  return [...out].sort();
}

export function qualifierConflicts(a: string, b: string): string[] {
  const ta = new Set(a.toLowerCase().split(/[^a-z0-9]+/));
  const tb = new Set(b.toLowerCase().split(/[^a-z0-9]+/));
  return QUALIFIERS.filter((q) => ta.has(q) !== tb.has(q));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function scorePair(pm: PolymarketCandidate, k: KalshiCandidate): Omit<MatchSuggestion, 'polymarket' | 'kalshi'> {
  const pmTokens = new Set(normalizeTokens(pm.question));
  const kText = `${k.title} ${k.yesSubTitle}`;
  const kTokens = new Set(normalizeTokens(kText));
  const tokenSimilarity = jaccard(pmTokens, kTokens);
  const pmNumbers = extractNumbers(pm.question);
  const kNumbers = extractNumbers(kText);
  const numbersMatch = pmNumbers.join('|') === kNumbers.join('|');
  const dateGapHours =
    pm.endDate && k.eventDate ? Math.abs(pm.endDate.getTime() - k.eventDate.getTime()) / 3_600_000 : null;
  const dateScore = dateGapHours === null ? 0.5 : dateGapHours <= 36 ? 1 : dateGapHours <= 7 * 24 ? 0.5 : 0;
  let confidence = 0.7 * tokenSimilarity + 0.2 * dateScore + 0.1 * (numbersMatch ? 1 : 0);
  if (!numbersMatch) confidence *= 0.5;
  const conflicts = qualifierConflicts(pm.question, kText);
  const pmDays = extractMonthDays(pm.question);
  const kDays = extractMonthDays(kText);
  if (pmDays.length > 0 && kDays.length > 0 && pmDays.join('|') !== kDays.join('|')) conflicts.push('date');
  if (conflicts.length > 0) confidence *= 0.6;
  if (dateGapHours !== null && dateGapHours > 30 * 24) confidence *= 0.5;
  const binary = pm.outcomes.length === 2 && pm.outcomes[0]?.toLowerCase() === 'yes';
  const exact =
    binary && numbersMatch && conflicts.length === 0 && dateGapHours !== null && dateGapHours <= 36 && tokenSimilarity >= 0.85 && confidence >= 0.9;
  return { confidence: Number(confidence.toFixed(3)), tokenSimilarity: Number(tokenSimilarity.toFixed(3)), numbersMatch, dateGapHours, exact, conflicts };
}

/** Best Kalshi candidate per Polymarket market, using an inverted token index to avoid an N x M scan. */
export function suggestMatches(
  polymarkets: PolymarketCandidate[],
  kalshis: KalshiCandidate[],
  minConfidence = 0.5,
): MatchSuggestion[] {
  const index = new Map<string, number[]>();
  kalshis.forEach((k, i) => {
    for (const t of new Set(normalizeTokens(`${k.title} ${k.yesSubTitle}`))) {
      const list = index.get(t) ?? [];
      list.push(i);
      index.set(t, list);
    }
  });
  const out: MatchSuggestion[] = [];
  const seen = new Set<string>();
  for (const pm of polymarkets) {
    if (seen.has(pm.conditionId)) continue;
    seen.add(pm.conditionId);
    const counts = new Map<number, number>();
    for (const t of new Set(normalizeTokens(pm.question))) {
      const list = index.get(t);
      if (!list || list.length > 2_000) continue; // too common to be informative
      for (const i of list) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    let best: MatchSuggestion | null = null;
    for (const [i, shared] of counts) {
      if (shared < 2) continue;
      const k = kalshis[i]!;
      const score = scorePair(pm, k);
      if (!best || score.confidence > best.confidence) best = { polymarket: pm, kalshi: k, ...score };
    }
    if (best && best.confidence >= minConfidence) out.push(best);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
