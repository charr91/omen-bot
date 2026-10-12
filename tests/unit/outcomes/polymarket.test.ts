import { describe, expect, it, vi } from 'vitest';
import {
  fetchMarketResolutions,
  fetchTokenPriceAt,
  parseGammaResolution,
  pickClosestPrice,
} from '../../../src/outcomes/polymarket.js';

describe('polymarket outcome sources', () => {
  it('picks the closest price point inside the window', () => {
    const points = [
      { t: 100, p: 0.1 },
      { t: 190, p: 0.2 },
      { t: 260, p: 0.3 },
    ];
    expect(pickClosestPrice(points, 200, 60)).toBe(0.2);
    expect(pickClosestPrice(points, 1_000, 60)).toBeNull();
  });

  it('queries CLOB prices-history around the target time', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ history: [{ t: 1_000, p: 0.42 }] })));
    await expect(fetchTokenPriceAt('123', new Date(1_000_000), { fetchImpl })).resolves.toBe(0.42);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe('/prices-history');
    expect(url.searchParams.get('market')).toBe('123');
    expect(url.searchParams.get('startTs')).toBe(String(1_000 - 900));
  });

  it('parses a resolved Gamma market into per-token final prices', () => {
    expect(
      parseGammaResolution({
        conditionId: '0xABC',
        closed: true,
        outcomePrices: '["1", "0"]',
        clobTokenIds: '["111", "222"]',
        umaResolutionStatus: 'resolved',
        closedTime: '2026-10-11 09:35:57+00',
      }),
    ).toEqual({
      conditionId: '0xabc',
      resolved: true,
      closedAt: new Date('2026-10-11T09:35:57Z'),
      tokenPrices: { '111': 1, '222': 0 },
    });
  });

  it('treats open, disputed or unsettled markets as unresolved', () => {
    const base = { conditionId: '0x1', clobTokenIds: '["1","2"]' };
    expect(parseGammaResolution({ ...base, closed: false, outcomePrices: '["1","0"]' })?.resolved).toBe(false);
    expect(parseGammaResolution({ ...base, closed: true, outcomePrices: '["0.5","0.5"]' })?.resolved).toBe(false);
    expect(
      parseGammaResolution({ ...base, closed: true, outcomePrices: '["1","0"]', umaResolutionStatus: 'disputed' })?.resolved,
    ).toBe(false);
  });

  it('asks Gamma for both closed and open markets', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('[]'));
    await fetchMarketResolutions(['0x1'], fetchImpl);
    const closedParams = fetchImpl.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('closed'));
    expect(closedParams).toEqual(['true', 'false']);
  });
});
