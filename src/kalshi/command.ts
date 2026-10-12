import { loadAppConfig } from '../config/index.js';
import { createDbPool } from '../persistence/db.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { createKalshiStore } from './store.js';
import { KalshiClient } from './client.js';
import { suggestMatches, type KalshiCandidate, type PolymarketCandidate } from './match.js';

const GAMMA = 'https://gamma-api.polymarket.com';

async function fetchPolymarketCandidates(limit: number): Promise<PolymarketCandidate[]> {
  const out: PolymarketCandidate[] = [];
  for (let offset = 0; offset < limit; offset += 100) {
    const url = `${GAMMA}/markets?closed=false&active=true&limit=100&offset=${offset}&order=volume24hr&ascending=false`;
    const response = await fetch(url);
    if (response.status === 422 && offset > 0) break; // Gamma caps the offset; treat as end of results
    if (!response.ok) throw new Error(`gamma markets failed: ${response.status}`);
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.conditionId !== 'string' || typeof row.question !== 'string') continue;
      let outcomes: string[] = [];
      try {
        outcomes = typeof row.outcomes === 'string' ? (JSON.parse(row.outcomes) as string[]) : [];
      } catch {
        outcomes = [];
      }
      const end = typeof row.endDate === 'string' ? Date.parse(row.endDate) : Number.NaN;
      out.push({
        conditionId: row.conditionId,
        question: row.question,
        endDate: Number.isFinite(end) ? new Date(end) : null,
        outcomes,
        volume24h: Number(row.volume24hr ?? 0) || 0,
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

export interface SuggestOptions {
  auto: boolean;
  minConfidence: number;
  polymarketLimit: number;
  kalshiPages: number;
  json: boolean;
}

export function parseSuggestOptions(args: string[]): SuggestOptions {
  const options: SuggestOptions = { auto: false, minConfidence: 0.6, polymarketLimit: 2_000, kalshiPages: 30, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--auto') options.auto = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--min') options.minConfidence = Number(args[++i]);
    else if (arg === '--pm-limit') options.polymarketLimit = Number(args[++i]);
    else if (arg === '--kalshi-pages') options.kalshiPages = Number(args[++i]);
    else throw new Error(`Unknown suggest option: ${arg}`);
  }
  return options;
}

/** omen kalshi-map <list|add|remove>: Polymarket market id (condition id) <-> Kalshi ticker pairs for divergence. */
export async function runKalshiMapCommand(args: string[]): Promise<string> {
  const [action, ...rest] = args;
  const config = await loadAppConfig();
  const pool = createDbPool(config);
  try {
    await ensurePersistenceSchema(pool);
    const store = createKalshiStore(pool);
    if (action === 'list') {
      const rows = await store.listMappings();
      if (rows.length === 0) return 'No mappings.';
      return rows
        .map((m) => `${m.polymarketMarketId}  ${m.kalshiTicker}${m.invert ? '  (inverted)' : ''}${m.note ? `  # ${m.note}` : ''}`)
        .join('\n');
    }
    if (action === 'suggest') {
      const options = parseSuggestOptions(rest);
      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarketCandidates(options.polymarketLimit),
        new KalshiClient().listOpenMarkets(options.kalshiPages),
      ]);
      const kalshis: KalshiCandidate[] = kalshiMarkets.map((m) => ({
        ticker: m.ticker,
        title: m.title,
        yesSubTitle: m.yesSubTitle ?? '',
        eventDate: m.expectedExpiration ?? m.closeTime,
        volume24h: m.volume24h,
      }));
      const suggestions = suggestMatches(polymarkets, kalshis, options.minConfidence);
      const existing = new Set((await store.listMappings()).map((m) => `${m.polymarketMarketId}|${m.kalshiTicker}`));
      const added: string[] = [];
      if (options.auto) {
        for (const s of suggestions.filter((x) => x.exact)) {
          const key = `${s.polymarket.conditionId}|${s.kalshi.ticker}`;
          if (existing.has(key)) continue;
          await store.addMapping({
            polymarketMarketId: s.polymarket.conditionId,
            kalshiTicker: s.kalshi.ticker,
            invert: false,
            note: `auto-suggest ${s.confidence}: ${s.polymarket.question.slice(0, 80)}`,
          });
          added.push(key);
        }
      }
      if (options.json) return JSON.stringify({ scanned: { polymarket: polymarkets.length, kalshi: kalshis.length }, suggestions, added }, null, 2);
      const lines = [
        `Scanned ${polymarkets.length} Polymarket x ${kalshis.length} Kalshi markets; ${suggestions.length} candidates >= ${options.minConfidence}.`,
        ...suggestions.map(
          (s) =>
            `${s.confidence.toFixed(3)}${s.exact ? ' EXACT' : '      '} tok=${s.tokenSimilarity.toFixed(2)} num=${s.numbersMatch ? 'ok' : 'DIFF'} dt=${s.dateGapHours === null ? '?' : `${Math.round(s.dateGapHours)}h`}${s.conflicts.length ? ` diff=${s.conflicts.join(',')}` : ''}\n` +
            `   PM ${s.polymarket.conditionId}  ${s.polymarket.question}\n   KX ${s.kalshi.ticker}  ${s.kalshi.title} / ${s.kalshi.yesSubTitle}`,
        ),
        options.auto ? `Auto-added ${added.length} exact match(es).` : 'Nothing added (pass --auto to add EXACT matches only).',
      ];
      return lines.join('\n');
    }
    if (action === 'add') {
      const invert = rest.includes('--invert');
      const noteIndex = rest.indexOf('--note');
      const note = noteIndex >= 0 ? rest[noteIndex + 1] ?? null : null;
      const positional = rest.filter((arg, i) => !arg.startsWith('--') && i !== noteIndex + 1);
      const [polymarketMarketId, kalshiTicker] = positional;
      if (!polymarketMarketId || !kalshiTicker) throw new Error('usage: kalshi-map add <polymarketMarketId> <kalshiTicker> [--invert] [--note text]');
      await store.addMapping({ polymarketMarketId, kalshiTicker, invert, note });
      return `Mapped ${polymarketMarketId} -> ${kalshiTicker}${invert ? ' (inverted)' : ''}`;
    }
    if (action === 'remove') {
      const [polymarketMarketId, kalshiTicker] = rest;
      if (!polymarketMarketId || !kalshiTicker) throw new Error('usage: kalshi-map remove <polymarketMarketId> <kalshiTicker>');
      return (await store.removeMapping(polymarketMarketId, kalshiTicker)) ? 'Removed.' : 'Not found.';
    }
    throw new Error('usage: kalshi-map <list|add|remove|suggest> [...]');
  } finally {
    await pool.end();
  }
}
