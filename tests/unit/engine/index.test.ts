import { describe, expect, it, vi } from 'vitest';
import { runIngestionCycle, type FillAnalyzer } from '../../../src/engine/index.js';
import type { FillStore } from '../../../src/persistence/queries/fills.js';
import type { FillRecord, NewFill } from '../../../src/types/fill.js';

function makeNewFill(overrides: Partial<NewFill> = {}): NewFill {
  return {
    id: 'fill-1',
    marketId: 'market-1',
    tokenId: 'asset-1',
    walletAddress: '0xwallet',
    side: 'BUY',
    outcome: 'YES',
    price: '0.400000',
    shares: '10.000000',
    sizeUsd: '4.000000',
    txHash: '0xtx-1',
    orderType: 'UNKNOWN',
    timestamp: new Date('2026-03-30T00:00:00.000Z'),
    ...overrides,
  };
}

function makeFillRecord(overrides: Partial<FillRecord> = {}): FillRecord {
  return {
    ...makeNewFill(),
    analyzed: false,
    createdAt: new Date('2026-03-30T00:00:00.000Z'),
    ...overrides,
  };
}

describe('runIngestionCycle', () => {
  it('inserts recent fills and replays all unanalyzed rows', async () => {
    const pending = [
      makeFillRecord({ id: 'existing-fill', txHash: '0xtx-existing' }),
      makeFillRecord({ id: 'fresh-fill', txHash: '0xtx-1' }),
    ];

    const fillStore: FillStore = {
      getLatestFillTimestamp: async () => new Date('2026-03-30T00:00:00.000Z'),
      insertFill: vi
        .fn<FillStore['insertFill']>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      listUnanalyzedFills: async () => pending,
      markFillAnalyzed: vi.fn<FillStore['markFillAnalyzed']>().mockResolvedValue(undefined),
    };
    const analyzer: FillAnalyzer = {
      analyze: vi.fn<FillAnalyzer['analyze']>().mockResolvedValue(undefined),
    };

    const result = await runIngestionCycle({
      fillSource: {
        listRecentFills: async () => [
          makeNewFill({ id: 'fresh-fill', txHash: '0xtx-1' }),
          makeNewFill({ id: 'duplicate-fill', txHash: '0xtx-2' }),
        ],
      },
      fillStore,
      analyzer,
    });

    expect(result.checkpoint).toBe('2026-03-30T00:00:00.000Z');
    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.replayed).toBe(2);
    expect(analyzer.analyze).toHaveBeenCalledTimes(2);
    expect(fillStore.markFillAnalyzed).toHaveBeenCalledTimes(2);
  });
});
