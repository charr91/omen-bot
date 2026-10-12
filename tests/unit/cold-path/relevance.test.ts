import { describe, expect, it, vi } from 'vitest';
import { decideColdJobSkip } from '../../../src/cold-path/relevance.js';
import { executeFundingGraphRebuild } from '../../../src/cold-path/rebuild.js';
import type { AlchemyFundingGraphBuilder } from '../../../src/clusters/alchemy-transfers.js';
import type { FundingEdgeStore } from '../../../src/persistence/queries/funding-edges.js';
import type { WalletStore } from '../../../src/persistence/queries/wallets.js';

const now = new Date('2026-10-12T20:00:00Z');

describe('decideColdJobSkip', () => {
  it('skips when the funding graph is younger than 24h', () => {
    expect(
      decideColdJobSkip({ fundingGraphBuiltAt: new Date('2026-10-12T00:00:00Z'), maxRecentFillUsd: 5_000, minFillUsd: 200, now }),
    ).toBe('graph-fresh');
  });

  it('skips stale jobs whose wallet has no recent fill at or above the min', () => {
    expect(decideColdJobSkip({ fundingGraphBuiltAt: null, maxRecentFillUsd: 150, minFillUsd: 200, now })).toBe(
      'no-recent-eligible-fill',
    );
    expect(decideColdJobSkip({ fundingGraphBuiltAt: null, maxRecentFillUsd: Number.NaN, minFillUsd: 200, now })).toBe(
      'no-recent-eligible-fill',
    );
  });

  it('rebuilds when the graph is old or missing and a recent fill is eligible', () => {
    expect(decideColdJobSkip({ fundingGraphBuiltAt: null, maxRecentFillUsd: 200, minFillUsd: 200, now })).toBeNull();
    expect(
      decideColdJobSkip({ fundingGraphBuiltAt: new Date('2026-10-10T00:00:00Z'), maxRecentFillUsd: 900, minFillUsd: 200, now }),
    ).toBeNull();
  });
});

describe('executeFundingGraphRebuild relevance gate', () => {
  it('completes a stale job without calling Alchemy', async () => {
    const builder = { buildGraph: vi.fn() } as unknown as AlchemyFundingGraphBuilder;
    const walletStore = {
      getSignalContext: vi.fn().mockResolvedValue({ fundingClusterId: 'fc:1', fundingGraphBuiltAt: null, controllerAddress: null }),
    } as unknown as WalletStore;
    const store = { getMaxRecentFillUsd: vi.fn().mockResolvedValue(40) };

    const result = await executeFundingGraphRebuild({
      walletAddress: '0xABC',
      builder,
      fundingEdgeStore: {} as FundingEdgeStore,
      walletStore,
      config: { detection: {} } as never,
      relevance: { store, minFillUsd: 200, now: () => now },
    });

    expect(result).toEqual({
      walletAddress: '0xabc',
      edgeCount: 0,
      truncated: false,
      fundingClusterId: 'fc:1',
      skipped: 'no-recent-eligible-fill',
    });
    expect(builder.buildGraph).not.toHaveBeenCalled();
    expect(store.getMaxRecentFillUsd).toHaveBeenCalledWith('0xabc', new Date('2026-10-11T20:00:00Z'));
  });
});
