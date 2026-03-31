import { describe, expect, it, vi } from 'vitest';
import { runIngestionCycle, type FillAnalysisQueue } from '../../../src/engine/index.js';
import type { FillCursor } from '../../../src/persistence/queries/fills.js';
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
    const latestCursor: FillCursor = {
      timestamp: new Date('2026-03-30T00:00:00.000Z'),
      seenFillKeysAtTimestamp: ['0xtx-existing|asset-1'],
    };
    const pending = [
      makeFillRecord({ id: 'existing-fill', txHash: '0xtx-existing' }),
      makeFillRecord({ id: 'fresh-fill', txHash: '0xtx-1' }),
    ];

    const fillStore: FillStore = {
      getLatestFillCursor: async () => latestCursor,
      insertFill: vi
        .fn<FillStore['insertFill']>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      listUnanalyzedFills: async () => pending,
      markFillAnalyzed: vi.fn<FillStore['markFillAnalyzed']>().mockResolvedValue(undefined),
      getRuntimeSummary: vi.fn<FillStore['getRuntimeSummary']>().mockResolvedValue({
        unanalyzedFillCount: 0,
        newestFillTimestamp: null,
      }),
    };
    const analysisQueue: FillAnalysisQueue = {
      enqueue: vi.fn<FillAnalysisQueue['enqueue']>().mockResolvedValue('accepted'),
    };
    const listRecentFills = vi
      .fn()
      .mockResolvedValue([
        makeNewFill({ id: 'fresh-fill', txHash: '0xtx-1' }),
        makeNewFill({ id: 'duplicate-fill', txHash: '0xtx-2' }),
      ]);

    const result = await runIngestionCycle({
      fillSource: {
        listRecentFills,
      },
      fillStore,
      analysisQueue,
    });

    expect(listRecentFills).toHaveBeenCalledWith(latestCursor);
    expect(result.checkpoint).toBe('2026-03-30T00:00:00.000Z');
    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.replayed).toBe(2);
    expect(analysisQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(fillStore.markFillAnalyzed).not.toHaveBeenCalled();
  });

  it('stops scheduling when the hot worker reports no remaining capacity', async () => {
    const pending = [
      makeFillRecord({ id: 'fill-1', txHash: '0xtx-1' }),
      makeFillRecord({ id: 'fill-2', txHash: '0xtx-2' }),
      makeFillRecord({ id: 'fill-3', txHash: '0xtx-3' }),
      makeFillRecord({ id: 'fill-4', txHash: '0xtx-4' }),
    ];

    const fillStore: FillStore = {
      getLatestFillCursor: async () => null,
      insertFill: vi.fn<FillStore['insertFill']>().mockResolvedValue(false),
      listUnanalyzedFills: async () => pending,
      markFillAnalyzed: vi.fn<FillStore['markFillAnalyzed']>().mockResolvedValue(undefined),
      getRuntimeSummary: vi.fn<FillStore['getRuntimeSummary']>().mockResolvedValue({
        unanalyzedFillCount: 0,
        newestFillTimestamp: null,
      }),
    };
    const analysisQueue: FillAnalysisQueue = {
      enqueue: vi
        .fn<FillAnalysisQueue['enqueue']>()
        .mockResolvedValueOnce('accepted')
        .mockResolvedValueOnce('accepted')
        .mockResolvedValueOnce('full'),
    };

    const result = await runIngestionCycle({
      fillSource: {
        listRecentFills: vi.fn().mockResolvedValue([]),
      },
      fillStore,
      analysisQueue,
    });

    expect(result.fetched).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.replayed).toBe(2);
    expect(analysisQueue.enqueue).toHaveBeenCalledTimes(3);
    expect(analysisQueue.enqueue).not.toHaveBeenCalledWith(pending[3]);
  });
});
