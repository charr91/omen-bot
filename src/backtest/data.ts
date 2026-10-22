import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { extractCategory, extractTags } from '../phase0/public-api.js';
import type { JsonObject } from '../phase0/types.js';

/**
 * Historical data for the offline backtest. Only public Polymarket HTTP APIs (data-api trades/activity, gamma
 * markets); no Alchemy, no database, no Redis. Every response is cached on disk so reruns are free and offline.
 */
const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const TRADE_PAGE = 10_000;
const ACTIVITY_PAGE = 500;

export interface RawTrade {
  proxyWallet: string;
  side: string;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  outcome: string;
  outcomeIndex?: number;
  name?: string;
  pseudonym?: string;
  transactionHash: string;
}

export interface RawActivity {
  timestamp: number;
  conditionId: string;
  type: string;
  size?: number;
  usdcSize?: number;
  side?: string;
  price?: number;
}

export interface RawMarket {
  conditionId: string;
  question: string;
  slug: string | null;
  eventSlug: string | null;
  volume: number;
  /** Gamma metadata, as live (include_tag=true): used by the sports/weather exclusion. */
  category?: string | null;
  tags?: string[];
  sportsMarketType?: string | null;
  /** When the market closed (resolved), unix seconds; prices after it are the resolution price. */
  closedAt?: number | null;
}

export interface WalletHistory {
  wallet: string;
  /** Activity up to the history end, newest first, at most ACTIVITY_PAGE rows. */
  events: RawActivity[];
  /** True when the page was full, so older activity exists beyond `events`. */
  truncated: boolean;
}

export type JsonGetter = (url: string) => Promise<unknown>;

/** Polite request pacing shared by every backtest HTTP call: at most `rps` request starts per second. */
let minGapMs = 1000 / 5;
let nextSlot = 0;
export function setRequestRate(rps: number): void {
  minGapMs = rps > 0 ? 1000 / rps : 0;
}
async function pace(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + minGapMs;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export const httpGetJson: JsonGetter = async (url) => {
  for (let attempt = 0; ; attempt += 1) {
    await pace();
    let response: Response;
    try {
      response = await fetch(url, { headers: { 'user-agent': 'omen-backtest/1' }, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      // Timeouts and dropped connections: back off and retry like a 5xx.
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt));
        continue;
      }
      throw error;
    }
    if (response.ok) return (await response.json()) as unknown;
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
      continue;
    }
    throw new Error(`GET ${url} -> ${response.status}`);
  }
};

export class BacktestDataSource {
  constructor(
    private readonly cacheDir: string,
    private readonly get: JsonGetter = httpGetJson,
    private readonly options: { offline?: boolean; refresh?: boolean } = {},
  ) {}

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const file = join(this.cacheDir, `${createHash('sha1').update(key).digest('hex').slice(0, 20)}.json.gz`);
    if (!this.options.refresh && existsSync(file)) {
      return JSON.parse(gunzipSync(await readFile(file)).toString('utf8')) as T;
    }
    if (this.options.offline) throw new Error(`offline and not cached: ${key}`);
    const value = await load();
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(file, gzipSync(JSON.stringify(value)));
    return value;
  }

  async market(conditionId: string): Promise<RawMarket> {
    // v2: adds category/tags/sportsMarketType (market exclusion) and closedAt (outcome pricing).
    return this.cached(`market:v2:${conditionId}`, async () => {
      const body = (await this.get(`${GAMMA_API}/markets?condition_ids=${conditionId}&closed=true&include_tag=true`)) as Array<Record<string, unknown>>;
      const m = body[0];
      if (!m) throw new Error(`gamma: no market ${conditionId}`);
      const events = (m.events as Array<{ slug?: string }> | undefined) ?? [];
      const closed = typeof m.closedTime === 'string' ? Date.parse(m.closedTime.replace(' ', 'T').replace(/\+00$/, 'Z')) : NaN;
      return {
        conditionId,
        question: String(m.question),
        slug: typeof m.slug === 'string' ? m.slug : null,
        eventSlug: events[0]?.slug ?? null,
        volume: Number(m.volume ?? 0),
        category: extractCategory(m as JsonObject),
        tags: extractTags(m as JsonObject),
        sportsMarketType: typeof m.sportsMarketType === 'string' && m.sportsMarketType ? m.sportsMarketType : null,
        closedAt: Number.isFinite(closed) ? Math.floor(closed / 1000) : null,
      };
    });
  }

  /** Every taker trade with start <= timestamp <= end, oldest first (paged backwards by `end`). */
  async trades(conditionId: string, start: number, end: number): Promise<RawTrade[]> {
    return this.cached(`trades:${conditionId}:${start}:${end}`, async () => {
      const seen = new Map<string, RawTrade>();
      let cursor = end;
      for (let guard = 0; guard < 500; guard += 1) {
        const url = `${DATA_API}/trades?market=${conditionId}&takerOnly=true&start=${start}&end=${cursor}&limit=${TRADE_PAGE}`;
        const page = (await this.get(url)) as RawTrade[];
        for (const t of page) seen.set(tradeKey(t), t);
        if (page.length < TRADE_PAGE) break;
        const oldest = Math.min(...page.map((t) => t.timestamp));
        // A full page of one second would loop forever; step past it (documented loss, never seen in practice).
        cursor = oldest === cursor ? oldest - 1 : oldest;
      }
      return [...seen.values()].sort((a, b) => a.timestamp - b.timestamp);
    });
  }

  /** The wallet's latest ACTIVITY_PAGE activity rows at or before `end`. */
  async walletHistory(wallet: string, end: number): Promise<WalletHistory> {
    return this.cached(`activity:${wallet}:${end}`, async () => {
      const page = (await this.get(`${DATA_API}/activity?user=${wallet}&end=${end}&limit=${ACTIVITY_PAGE}`)) as RawActivity[];
      const events = page.map((e) => ({
        timestamp: e.timestamp,
        conditionId: e.conditionId,
        type: e.type,
        size: e.size,
        usdcSize: e.usdcSize,
        side: e.side,
        price: e.price,
      }));
      return { wallet, events, truncated: page.length >= ACTIVITY_PAGE };
    });
  }
}

export function tradeKey(t: Pick<RawTrade, 'transactionHash' | 'asset' | 'proxyWallet' | 'side' | 'size' | 'price'>): string {
  return `${t.transactionHash}:${t.asset}:${t.proxyWallet}:${t.side}:${t.size}:${t.price}`;
}

/** Run `fn` over items with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
