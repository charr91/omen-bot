import { POLYMARKET_DATA_API_URL } from '../phase0/constants.js';

/**
 * Gamma's `volume24hr` is a lagging aggregate: for the Bragantino–Cruzeiro draw market it read $617 at alert time
 * while the market's own trades summed to ~$3.7k over the prior 24 h (and $27.8k an hour later, in-play). For the
 * niche-market and size-relative thresholds we therefore use the larger of Gamma's figure and the market's own
 * trade tape over the 24 h before the fill (data-api /trades, taker side so each match is counted once).
 */
export interface TradeTapeRow {
  timestamp: number;
  size: number | string;
  price: number | string;
}

export type TradeTapeFetcher = (conditionId: string, offset: number, limit: number) => Promise<TradeTapeRow[]>;

const PAGE = 500;
const MAX_PAGES = 6;

export const fetchTradeTape: TradeTapeFetcher = async (conditionId, offset, limit) => {
  const url = new URL('/trades', POLYMARKET_DATA_API_URL);
  url.searchParams.set('market', conditionId);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('takerOnly', 'true');
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`trade tape ${response.status} for ${conditionId}`);
  const body = (await response.json()) as unknown;
  return Array.isArray(body) ? (body as TradeTapeRow[]) : [];
};

/** USD notional traded in [at - 24h, at). Pages newest-first until older than the window or the page cap. */
export async function tradeTapeVolume24h(conditionId: string, at: Date, fetcher: TradeTapeFetcher = fetchTradeTape): Promise<number> {
  const end = Math.floor(at.getTime() / 1000);
  const start = end - 86_400;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await fetcher(conditionId, page * PAGE, PAGE);
    for (const row of rows) {
      if (row.timestamp >= start && row.timestamp < end) {
        const v = Number(row.size) * Number(row.price);
        if (Number.isFinite(v)) total += v;
      }
    }
    if (rows.length < PAGE || rows.every((r) => r.timestamp < start)) break;
  }
  return total;
}

/** Cached per market for a minute; failures fall back to Gamma's figure (never block a fill). */
export class MarketVolumeRefiner {
  private readonly cache = new Map<string, { at: number; value: number }>();

  constructor(
    private readonly fetcher: TradeTapeFetcher = fetchTradeTape,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async dailyVolumeUsd(conditionId: string, gammaDailyVolumeUsd: string, fillAt: Date): Promise<{ value: string; source: 'gamma' | 'trades' }> {
    const gamma = Number(gammaDailyVolumeUsd) || 0;
    const key = `${conditionId}:${Math.floor(fillAt.getTime() / this.ttlMs)}`;
    let tape = this.cache.get(key);
    if (!tape || this.now() - tape.at > this.ttlMs) {
      try {
        tape = { at: this.now(), value: await tradeTapeVolume24h(conditionId, fillAt, this.fetcher) };
        if (this.cache.size > 5_000) this.cache.clear();
        this.cache.set(key, tape);
      } catch {
        return { value: gammaDailyVolumeUsd, source: 'gamma' };
      }
    }
    return tape.value > gamma ? { value: tape.value.toFixed(6), source: 'trades' } : { value: gammaDailyVolumeUsd, source: 'gamma' };
  }
}
