import { describe, expect, it, vi } from 'vitest';
import { isMultivariateTicker, parseKalshiMarket, parseKalshiTrade, seriesTickerOf, KalshiClient } from '../../../src/kalshi/client.js';
import {
  DEFAULT_KALSHI_SIGNAL_CONFIG as cfg,
  evaluateBlockTrade,
  evaluateBookMove,
  evaluateDivergence,
  evaluateVolumeSpike,
} from '../../../src/kalshi/signals.js';
import { KalshiService } from '../../../src/kalshi/service.js';

const rawTrade = (o: Record<string, unknown> = {}) => ({
  trade_id: 't1', ticker: 'KXTEST-1', created_time: '2026-10-12T20:00:00Z',
  yes_price_dollars: '0.40', no_price_dollars: '0.60', count_fp: '1000', taker_side: 'no', is_block_trade: false, ...o,
});

describe('kalshi parsing', () => {
  it('parses trades with taker-side notional', () => {
    const t = parseKalshiTrade(rawTrade())!;
    expect(t.notionalUsd).toBeCloseTo(600);
    expect(t.takerSide).toBe('no');
    expect(parseKalshiTrade(rawTrade({ taker_side: 'x' }))).toBeNull();
  });
  it('parses markets and helpers', () => {
    const m = parseKalshiMarket({ ticker: 'A', event_ticker: 'KXSER-26OCT12', yes_bid_dollars: '0.3', yes_ask_dollars: '0.32', result: 'yes' })!;
    expect(m.yesBid).toBe(0.3);
    expect(m.result).toBe('yes');
    expect(seriesTickerOf('KXSER-26OCT12')).toBe('KXSER');
    expect(isMultivariateTicker('KXMVESPORTS-1')).toBe(true);
  });
  it('retries 429 without an API key header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ markets: [{ ticker: 'A', event_ticker: 'E' }] }), { status: 200 }));
    const client = new KalshiClient({ fetchImpl: fetchImpl as unknown as typeof fetch, minSpacingMs: 0, sleep: async () => {} });
    const markets = await client.getMarkets(['A']);
    expect(markets.map((m) => m.ticker)).toEqual(['A']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit | undefined;
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/KALSHI-ACCESS/i);
  });
});

describe('kalshi signals', () => {
  it('block trade: exchange flag or large print', () => {
    const small = parseKalshiTrade(rawTrade())!;
    expect(evaluateBlockTrade(small, cfg)).toBeNull();
    expect(evaluateBlockTrade({ ...small, isBlockTrade: true }, cfg)?.side).toBe('no');
    expect(evaluateBlockTrade({ ...small, notionalUsd: 20_000 }, cfg)?.signalId).toBe('KALSHI_BLOCK_TRADE');
  });

  it('volume spike needs a day of history and fires on a large hour', () => {
    const now = new Date('2026-10-12T20:30:00Z');
    const hour = new Date('2026-10-12T20:00:00Z');
    const history = Array.from({ length: 72 }, (_, i) => ({
      hour: new Date(hour.getTime() - (i + 1) * 3_600_000), notionalUsd: 1_000 + (i % 5) * 50, yesNotionalUsd: 500,
    }));
    const current = { hour, notionalUsd: 50_000, yesNotionalUsd: 40_000 };
    expect(evaluateVolumeSpike('A', history.slice(0, 10), current, now, 0.5, cfg)).toBeNull();
    const s = evaluateVolumeSpike('A', history, current, now, 0.5, cfg);
    expect(s?.side).toBe('yes');
    expect(evaluateVolumeSpike('A', history, { ...current, notionalUsd: 1_100, yesNotionalUsd: 500 }, now, 0.5, cfg)).toBeNull();
  });

  it('book move: mid move and depth pull', () => {
    const t0 = new Date('2026-10-12T20:00:00Z');
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    const snap = (at: Date, bid: number, ask: number, bs = 500, as = 500) => ({ at, yesBid: bid, yesAsk: ask, bidSize: bs, askSize: as });
    expect(evaluateBookMove('A', [snap(t0, 0.4, 0.42), snap(t1, 0.5, 0.52)], cfg)?.side).toBe('yes');
    expect(evaluateBookMove('A', [snap(t0, 0.4, 0.42), snap(t1, 0.41, 0.43)], cfg)).toBeNull();
    const pull = evaluateBookMove('A', [snap(t0, 0.4, 0.42), snap(t1, 0.4, 0.42, 50, 500)], cfg);
    expect(pull?.side).toBe('no');
  });

  it('divergence points toward the Polymarket price', () => {
    const at = new Date();
    const ctx = { polymarketMarketId: '0xabc', recentPolymarketSignals: 0 };
    expect(evaluateDivergence('A', 0.4, 0.5, at, ctx, cfg)?.side).toBe('yes');
    expect(evaluateDivergence('A', 0.4, 0.43, at, ctx, cfg)).toBeNull();
    expect(evaluateDivergence('A', 0.6, 0.5, at, ctx, cfg)?.side).toBe('no');
  });
});

describe('KalshiService', () => {
  const fakeStore = () => ({
    addHourlyVolume: vi.fn(async () => {}),
    insertTrades: vi.fn(async () => {}),
    insertSignal: vi.fn(async () => true),
  });
  it('dedupes overlapping polls and stores only large prints', async () => {
    const trades = [
      parseKalshiTrade(rawTrade({ trade_id: 'a' }))!,
      parseKalshiTrade(rawTrade({ trade_id: 'b', count_fp: '50000' }))!,
      parseKalshiTrade(rawTrade({ trade_id: 'c', count_fp: '10' }))!,
    ];
    const client = { listTradesSince: vi.fn(async () => ({ trades, complete: true })), getMarkets: vi.fn() };
    const store = fakeStore();
    const service = new KalshiService(client as never, store as never, {
      ...cfg, storeMinNotionalUsd: 250, maxTradePagesPerPoll: 5, bookWatchlistSize: 10, divergenceCooldownMs: 1, bookMoveCooldownMs: 1,
    }, () => new Date('2026-10-12T20:01:00Z'));
    const first = await service.pollTrades();
    expect(first.trades).toBe(3);
    expect(first.storedTrades).toBe(2);
    expect(first.signals.KALSHI_BLOCK_TRADE).toBe(1);
    const second = await service.pollTrades();
    expect(second.trades).toBe(0);
  });
});
