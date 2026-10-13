import { describe, expect, it, vi } from 'vitest';
import { OutcomeTracker } from '../../../src/outcomes/tracker.js';
import type { TradeOutcomeStore } from '../../../src/outcomes/store.js';
import { parseStatsOptions } from '../../../src/outcomes/command.js';

function makeStore(overrides: Partial<TradeOutcomeStore> = {}): TradeOutcomeStore {
  return {
    enrollSignalFills: vi.fn().mockResolvedValue(2),
    sampleBaselines: vi.fn().mockResolvedValue(5),
    listSignalRowsMissingContext: vi.fn().mockResolvedValue([]),
    listMarketHourlyVolume: vi.fn().mockResolvedValue([]),
    setVolumeContext: vi.fn(),
    listPendingPrices: vi.fn(async (horizon: string) =>
      horizon === '1h'
        ? [
            { fillId: 'f1', tokenId: 't1', targetAt: new Date('2026-10-12T10:00:00Z') },
            { fillId: 'f2', tokenId: 't2', targetAt: new Date('2026-10-12T10:00:00Z') },
          ]
        : [],
    ),
    setPrice: vi.fn(),
    findNearestFillPrice: vi.fn().mockResolvedValue(0.61),
    listUnresolvedMarkets: vi.fn().mockResolvedValue(['0xM']),
    markMarketsChecked: vi.fn(),
    setResolution: vi.fn().mockResolvedValue(3),
    listOutcomes: vi.fn(),
    listMarketsMissingGameStart: vi.fn().mockResolvedValue([]),
    setGameStart: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as TradeOutcomeStore;
}

describe('OutcomeTracker', () => {
  it('enrolls, samples baselines without market makers, prices horizons with fill fallback, and resolves markets', async () => {
    const store = makeStore();
    const marketMakers = { listLikelyMarketMakers: vi.fn().mockResolvedValue(['0xmm']) };
    const now = new Date('2026-10-12T12:00:00Z');
    const tracker = new OutcomeTracker({
      store,
      marketMakers,
      baselinePerSignal: 3,
      baselineWindowHours: 6,
      marketMakerMinScore: 70,
      now: () => now,
      priceAt: vi.fn(async (token: string) => (token === 't1' ? 0.55 : null)),
      resolutions: vi.fn().mockResolvedValue([
        { conditionId: '0xm', resolved: true, closedAt: now, tokenPrices: { t1: 1, t2: 0 } },
      ]),
    });

    const result = await tracker.runOnce();

    expect(result).toMatchObject({ enrolled: 2, baselines: 5, prices1h: 2, prices24h: 0, resolved: 3, errors: [] });
    expect(store.sampleBaselines).toHaveBeenCalledWith(3, 6, 200, ['0xmm']);
    expect(store.setPrice).toHaveBeenCalledWith('1h', 'f1', 0.55, now);
    expect(store.setPrice).toHaveBeenCalledWith('1h', 'f2', 0.61, now);
    expect(store.setResolution).toHaveBeenCalledWith('0xM', { t1: 1, t2: 0 }, now);
    expect(store.markMarketsChecked).toHaveBeenCalledWith(['0xM'], now);
  });

  it('records the volume-spike context for the hour before a signal', async () => {
    const alertAt = new Date('2026-10-12T14:30:00Z');
    const hourly = [
      { hour: new Date('2026-10-11T14:00:00Z'), volumeUsd: 100 },
      { hour: new Date('2026-10-10T14:00:00Z'), volumeUsd: 100 },
      { hour: new Date('2026-10-12T14:00:00Z'), volumeUsd: 900 },
    ];
    const store = makeStore({
      listSignalRowsMissingContext: vi.fn().mockResolvedValue([{ fillId: 'f9', marketId: 'm', alertAt }]),
      listMarketHourlyVolume: vi.fn().mockResolvedValue(hourly),
      listPendingPrices: vi.fn().mockResolvedValue([]),
      listUnresolvedMarkets: vi.fn().mockResolvedValue([]),
    });
    const tracker = new OutcomeTracker({
      store,
      marketMakers: { listLikelyMarketMakers: vi.fn().mockResolvedValue([]) },
      baselinePerSignal: 3,
      baselineWindowHours: 6,
      marketMakerMinScore: 70,
    });
    await tracker.runOnce();
    expect(store.setVolumeContext).toHaveBeenCalledWith('f9', true, 9);
  });

  it('keeps going and reports errors per step', async () => {
    const store = makeStore({ enrollSignalFills: vi.fn().mockRejectedValue(new Error('db down')) });
    const tracker = new OutcomeTracker({
      store,
      marketMakers: { listLikelyMarketMakers: vi.fn().mockResolvedValue([]) },
      baselinePerSignal: 3,
      baselineWindowHours: 6,
      marketMakerMinScore: 70,
      priceAt: vi.fn().mockResolvedValue(0.5),
      resolutions: vi.fn().mockResolvedValue([]),
    });
    const result = await tracker.runOnce();
    expect(result.errors).toEqual(['enroll: db down']);
    expect(result.baselines).toBe(5);
  });
});

describe('parseStatsOptions', () => {
  it('parses days, json and refresh flags', () => {
    expect(parseStatsOptions([])).toEqual({ days: 7, json: false, refresh: false });
    expect(parseStatsOptions(['--days', '14', '--json', '--refresh'])).toEqual({ days: 14, json: true, refresh: true });
    expect(parseStatsOptions(['--days=2'])).toMatchObject({ days: 2 });
    expect(() => parseStatsOptions(['--days', '0'])).toThrow();
    expect(() => parseStatsOptions(['--bogus'])).toThrow();
  });

  it('flags in-play markets from Gamma game starts before sampling baselines, and retries markets Gamma omitted', async () => {
    const now = new Date('2026-10-13T01:00:00Z');
    const store = makeStore({
      listMarketsMissingGameStart: vi.fn().mockResolvedValue(['0xGame', '0xPolitics', '0xMissing']),
      listPendingPrices: vi.fn().mockResolvedValue([]),
      listUnresolvedMarkets: vi.fn().mockResolvedValue([]),
    });
    const order: string[] = [];
    (store.setGameStart as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('game'); return 1; });
    (store.sampleBaselines as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('baseline'); return 0; });
    const tracker = new OutcomeTracker({
      store, marketMakers: { listLikelyMarketMakers: vi.fn().mockResolvedValue([]) }, baselinePerSignal: 3,
      baselineWindowHours: 6, marketMakerMinScore: 70, now: () => now,
      gameStarts: vi.fn().mockResolvedValue(new Map([['0xgame', '2026-10-13T00:00:00.000Z'], ['0xpolitics', null]])),
    });
    const result = await tracker.runOnce();
    expect(result.errors).toEqual([]);
    expect(store.setGameStart).toHaveBeenCalledWith('0xGame', new Date('2026-10-13T00:00:00Z'), now);
    expect(store.setGameStart).toHaveBeenCalledWith('0xPolitics', null, now);
    expect(store.setGameStart).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['game', 'game', 'baseline']);
  });
});
