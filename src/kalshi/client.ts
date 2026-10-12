/**
 * Kalshi public REST client (no API key: market data endpoints are unauthenticated).
 * Requests are serialized with a minimum spacing and retried with backoff on HTTP 429.
 */
export const KALSHI_API_URL = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiTrade {
  tradeId: string;
  ticker: string;
  createdAt: Date;
  yesPrice: number;
  noPrice: number;
  count: number;
  takerSide: 'yes' | 'no';
  isBlockTrade: boolean;
  /** Dollars paid by the taker: count x price of the side taken. */
  notionalUsd: number;
}

export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  status: string;
  result: string;
  closeTime: Date | null;
  volume24h: number;
  yesBid: number | null;
  yesAsk: number | null;
  yesBidSize: number;
  yesAskSize: number;
  lastPrice: number | null;
}

export interface KalshiCandle {
  endTs: number;
  yesBidClose: number | null;
  yesAskClose: number | null;
  priceClose: number | null;
}

/** Multivariate (parlay) markets: thousands of synthetic tickers, excluded everywhere. */
export function isMultivariateTicker(ticker: string): boolean {
  return ticker.startsWith('KXMVE');
}

/** Series ticker is the event ticker's first segment (e.g. KXSERIEAGAME-26OCT12TORUDI -> KXSERIEAGAME). */
export function seriesTickerOf(eventTicker: string): string {
  return eventTicker.split('-')[0] ?? eventTicker;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseKalshiTrade(raw: Record<string, unknown>): KalshiTrade | null {
  const tradeId = typeof raw.trade_id === 'string' ? raw.trade_id : null;
  const ticker = typeof raw.ticker === 'string' ? raw.ticker : null;
  const created = typeof raw.created_time === 'string' ? Date.parse(raw.created_time) : Number.NaN;
  const yesPrice = num(raw.yes_price_dollars);
  const noPrice = num(raw.no_price_dollars);
  const count = num(raw.count_fp ?? raw.count);
  const takerSide = raw.taker_side === 'yes' || raw.taker_side === 'no' ? raw.taker_side : null;
  if (!tradeId || !ticker || !Number.isFinite(created) || yesPrice === null || noPrice === null || count === null || !takerSide) {
    return null;
  }
  return {
    tradeId,
    ticker,
    createdAt: new Date(created),
    yesPrice,
    noPrice,
    count,
    takerSide,
    isBlockTrade: raw.is_block_trade === true,
    notionalUsd: count * (takerSide === 'yes' ? yesPrice : noPrice),
  };
}

export function parseKalshiMarket(raw: Record<string, unknown>): KalshiMarket | null {
  const ticker = typeof raw.ticker === 'string' ? raw.ticker : null;
  if (!ticker) return null;
  const close = typeof raw.close_time === 'string' ? Date.parse(raw.close_time) : Number.NaN;
  return {
    ticker,
    eventTicker: typeof raw.event_ticker === 'string' ? raw.event_ticker : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    result: typeof raw.result === 'string' ? raw.result : '',
    closeTime: Number.isFinite(close) ? new Date(close) : null,
    volume24h: num(raw.volume_24h_fp ?? raw.volume_24h) ?? 0,
    yesBid: num(raw.yes_bid_dollars),
    yesAsk: num(raw.yes_ask_dollars),
    yesBidSize: num(raw.yes_bid_size_fp) ?? 0,
    yesAskSize: num(raw.yes_ask_size_fp) ?? 0,
    lastPrice: num(raw.last_price_dollars),
  };
}

export interface KalshiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  minSpacingMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class KalshiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minSpacingMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: KalshiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? KALSHI_API_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.minSpacingMs = options.minSpacingMs ?? 150;
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const run = async (): Promise<T> => {
      const url = new URL(`${this.baseUrl}${path}`);
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
      for (let attempt = 0; ; attempt += 1) {
        const wait = this.lastRequestAt + this.minSpacingMs - Date.now();
        if (wait > 0) await this.sleep(wait);
        this.lastRequestAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        let response: Response;
        try {
          response = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        } finally {
          clearTimeout(timer);
        }
        if (response.status === 429 && attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw new Error(`Kalshi ${path} failed: ${response.status} ${response.statusText}`);
        return (await response.json()) as T;
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** Trades newer than `minTs` (unix seconds), newest first; pages with the cursor up to `maxPages`. */
  async listTradesSince(minTs: number, maxPages: number): Promise<{ trades: KalshiTrade[]; complete: boolean }> {
    const trades: KalshiTrade[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await this.get<{ trades?: Record<string, unknown>[]; cursor?: string }>('/markets/trades', {
        limit: '1000',
        min_ts: String(minTs),
        cursor,
      });
      for (const raw of payload.trades ?? []) {
        const trade = parseKalshiTrade(raw);
        if (trade && !isMultivariateTicker(trade.ticker)) trades.push(trade);
      }
      cursor = payload.cursor || undefined;
      if (!cursor) return { trades, complete: true };
    }
    return { trades, complete: false };
  }

  async getMarkets(tickers: string[]): Promise<KalshiMarket[]> {
    const markets: KalshiMarket[] = [];
    for (let i = 0; i < tickers.length; i += 50) {
      const batch = tickers.slice(i, i + 50);
      const payload = await this.get<{ markets?: Record<string, unknown>[] }>('/markets', {
        tickers: batch.join(','),
        limit: String(batch.length),
      });
      for (const raw of payload.markets ?? []) {
        const market = parseKalshiMarket(raw);
        if (market) markets.push(market);
      }
    }
    return markets;
  }

  async listOpenMarkets(maxPages: number): Promise<KalshiMarket[]> {
    const markets: KalshiMarket[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await this.get<{ markets?: Record<string, unknown>[]; cursor?: string }>('/markets', {
        status: 'open',
        limit: '1000',
        mve_filter: 'exclude',
        cursor,
      });
      for (const raw of payload.markets ?? []) {
        const market = parseKalshiMarket(raw);
        if (market && !isMultivariateTicker(market.ticker)) markets.push(market);
      }
      cursor = payload.cursor || undefined;
      if (!cursor) break;
    }
    return markets;
  }

  /** One-minute candles; yes bid/ask closes give a mid price at a point in time. */
  async getCandles(seriesTicker: string, ticker: string, startTs: number, endTs: number): Promise<KalshiCandle[]> {
    const payload = await this.get<{ candlesticks?: Array<Record<string, any>> }>(
      `/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(ticker)}/candlesticks`,
      { start_ts: String(startTs), end_ts: String(endTs), period_interval: '1' },
    );
    return (payload.candlesticks ?? []).map((c) => ({
      endTs: Number(c.end_period_ts),
      yesBidClose: num(c.yes_bid?.close_dollars),
      yesAskClose: num(c.yes_ask?.close_dollars),
      priceClose: num(c.price?.close_dollars),
    }));
  }

  /** Yes mid (or last trade) price closest to `at`, within +/- windowSec. */
  async getYesPriceAt(eventTicker: string, ticker: string, at: Date, windowSec = 15 * 60): Promise<number | null> {
    const target = Math.floor(at.getTime() / 1000);
    const candles = await this.getCandles(seriesTickerOf(eventTicker), ticker, target - windowSec, target + windowSec);
    let best: { distance: number; price: number } | null = null;
    for (const candle of candles) {
      const mid =
        candle.yesBidClose !== null && candle.yesAskClose !== null && candle.yesAskClose > 0
          ? (candle.yesBidClose + candle.yesAskClose) / 2
          : candle.priceClose;
      if (mid === null) continue;
      const distance = Math.abs(candle.endTs - target);
      if (best === null || distance < best.distance) best = { distance, price: mid };
    }
    return best?.price ?? null;
  }
}
