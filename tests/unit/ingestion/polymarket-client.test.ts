import { describe, expect, it } from 'vitest';
import { listRecentFills, normalizeTradeToFill } from '../../../src/ingestion/polymarket-client.js';
import type { JsonObject } from '../../../src/phase0/types.js';

function makeTrade(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    proxyWallet: '0xwallet',
    transactionHash: '0xtx-1',
    asset: 'asset-1',
    conditionId: 'market-1',
    side: 'BUY',
    outcome: 'Yes',
    price: 0.42,
    size: 10,
    timestamp: 1_710_000_000,
    ...overrides,
  };
}

describe('polymarket fill source', () => {
  it('normalizes a public trade into a fill record', () => {
    const fill = normalizeTradeToFill(makeTrade());

    expect(fill).not.toBeNull();
    expect(fill?.marketId).toBe('market-1');
    expect(fill?.tokenId).toBe('asset-1');
    expect(fill?.outcome).toBe('YES');
    expect(fill?.sizeUsd).toBe('4.200000');
    expect(fill?.orderType).toBe('UNKNOWN');
  });

  it('dedupes fills by txHash and token and stops after older pages', async () => {
    const firstPage = [
      makeTrade({ transactionHash: '0xtx-1', timestamp: 1_710_000_010 }),
      makeTrade({ transactionHash: '0xtx-1', timestamp: 1_710_000_010 }),
      makeTrade({ transactionHash: '0xtx-2', timestamp: 1_710_000_009 }),
      ...Array.from({ length: 497 }, (_, index) =>
        makeTrade({
          proxyWallet: '',
          transactionHash: `0xfiller-${index}`,
          timestamp: 1_710_000_008,
        }),
      ),
    ];
    const secondPage = [
      makeTrade({ transactionHash: '0xtx-3', timestamp: 1_710_000_000 }),
      makeTrade({ transactionHash: '0xtx-4', timestamp: 1_709_999_999 }),
    ];

    const offsets: number[] = [];
    const fills = await listRecentFills({
      sinceTimestampMs: 1_710_000_000_000,
      maxPagesPerPoll: 3,
      fetchPage: async (offset) => {
        offsets.push(offset);
        if (offset === 0) {
          return firstPage;
        }
        if (offset === 500) {
          return secondPage;
        }
        return [];
      },
    });

    expect(offsets).toEqual([0, 500]);
    expect(fills.map((fill) => fill.txHash)).toEqual(['0xtx-3', '0xtx-2', '0xtx-1']);
  });
});
