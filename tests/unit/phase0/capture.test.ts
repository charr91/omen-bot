import { describe, expect, it, vi } from 'vitest';
import {
  fetchVisiblePublicTrades,
  selectNewPublicTrades,
  stableTradeObservationKey,
} from '../../../src/phase0/capture.js';
import type { JsonObject } from '../../../src/phase0/types.js';

function makeTrade(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    proxyWallet: '0xwallet',
    transactionHash: '0xtx-default',
    asset: 'asset-1',
    conditionId: 'market-1',
    side: 'BUY',
    price: 0.52,
    size: 100,
    timestamp: 1_710_000_000,
    ...overrides,
  };
}

describe('phase0 capture helpers', () => {
  it('filters already-known trades and dedupes within the same poll', () => {
    const first = makeTrade({ transactionHash: '0xtx-1' });
    const second = makeTrade({ transactionHash: '0xtx-2' });
    const known = new Set([stableTradeObservationKey(first)]);
    const pollSeenKeys = new Set<string>();

    const result = selectNewPublicTrades([first, second, second], known, pollSeenKeys);

    expect(result).toHaveLength(1);
    expect(result[0]?.trade).toEqual(second);
    expect(pollSeenKeys.size).toBe(1);
  });

  it('stops paginating once it hits a fully-seen page from a prior poll', async () => {
    const first = makeTrade({ transactionHash: '0xtx-1' });
    const second = makeTrade({ transactionHash: '0xtx-2' });
    const third = makeTrade({ transactionHash: '0xtx-3' });

    const known = new Set([
      stableTradeObservationKey(second),
      stableTradeObservationKey(third),
    ]);

    const fetchPage = vi
      .fn<(offset: number) => Promise<JsonObject[]>>()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second, third])
      .mockResolvedValueOnce([makeTrade({ transactionHash: '0xtx-4' })]);

    const result = await fetchVisiblePublicTrades(known, fetchPage, 2);

    expect(result).toHaveLength(1);
    expect(result[0]?.trade).toEqual(first);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2);
  });

  it('fails loudly instead of truncating when the recent trade window exceeds the max offset', async () => {
    const first = makeTrade({ transactionHash: '0xtx-1' });
    const second = makeTrade({ transactionHash: '0xtx-2' });
    const fetchPage = vi
      .fn<(offset: number) => Promise<JsonObject[]>>()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([makeTrade({ transactionHash: '0xtx-3' }), makeTrade({ transactionHash: '0xtx-4' })]);

    await expect(fetchVisiblePublicTrades(new Set<string>(), fetchPage, 2, 2)).rejects.toThrow(
      'Public trade window exceeded max paginable offset 2',
    );
  });

  it('fails loudly when maxOffset is not divisible by pageSize and more full pages remain', async () => {
    const fetchPage = vi
      .fn<(offset: number) => Promise<JsonObject[]>>()
      .mockResolvedValueOnce([makeTrade({ transactionHash: '0xtx-1' }), makeTrade({ transactionHash: '0xtx-2' })])
      .mockResolvedValueOnce([makeTrade({ transactionHash: '0xtx-3' }), makeTrade({ transactionHash: '0xtx-4' })]);

    await expect(fetchVisiblePublicTrades(new Set<string>(), fetchPage, 2, 3)).rejects.toThrow(
      'Public trade window exceeded max paginable offset 3',
    );
  });
});
