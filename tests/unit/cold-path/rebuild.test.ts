import { describe, expect, it, vi } from 'vitest';
import { executeFundingGraphRebuild } from '../../../src/cold-path/rebuild.js';
import type { AlchemyFundingGraphBuilder } from '../../../src/clusters/alchemy-transfers.js';
import type { AppConfig } from '../../../src/config/schema.js';
import type { FundingEdgeStore } from '../../../src/persistence/queries/funding-edges.js';
import type { WalletStore } from '../../../src/persistence/queries/wallets.js';

function makeConfig(): Pick<AppConfig, 'detection'> {
  return {
    detection: {
      freshWallet: {
        criticalAgeHours: 24,
        elevatedAgeHours: 72,
        maxTransactions: 10,
      },
      market: {
        nicheMaxVolume: 100_000,
        largePositionMinUsd: 1_000,
        largePositionVolumePct: 0.02,
      },
      nicheMarketEntry: {
        maxMarketVolumeUsd: 100_000,
        minFillUsd: 1_000,
      },
      convictionSizeMismatch: {
        maxWalletTotalVolumeUsd: 5_000,
        minFillToWalletVolumeRatio: 0.5,
        longshotMaxPrice: 0.3,
        minFillUsd: 250,
      },
      lumpEntry: {
        minFillUsd: 500,
        minLumpRatio: 0.8,
      },
      cluster: {
        minSize: 3,
        minFillUsd: 25,
        fundingMaxDepth: 4,
        fanoutLimit: 5,
        maxRpcCalls: 200,
      },
    },
  };
}

describe('executeFundingGraphRebuild', () => {
  it('rebuilds root edges and assigns the resolved funding cluster members', async () => {
    const builder = {
      buildGraph: vi.fn<AlchemyFundingGraphBuilder['buildGraph']>().mockResolvedValue({
        edges: [
          {
            fromAddress: '0xancestor-a',
            toAddress: '0xroot',
            amountUsd: '1000.000000',
            asset: 'USDC',
            txHash: '0xtx-edge',
            timestamp: new Date('2026-04-01T00:00:00.000Z'),
            depth: 1,
          },
        ],
        truncated: false,
      }),
    } as unknown as AlchemyFundingGraphBuilder;
    const fundingEdgeStore = {
      listEdgesForRoot: vi.fn<FundingEdgeStore['listEdgesForRoot']>().mockResolvedValue([
        {
          id: 'edge-1',
          fromAddress: '0xancestor-a',
          toAddress: '0xroot',
          amountUsd: '1000.000000',
          asset: 'USDC',
          txHash: '0xtx-edge',
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
          depth: 1,
          rootWallet: '0xroot',
        },
      ]),
      listAncestorMemberships: vi.fn<FundingEdgeStore['listAncestorMemberships']>().mockResolvedValue([
        { ancestorAddress: '0xancestor-a', rootWallet: '0xroot', minDepth: 1 },
        { ancestorAddress: '0xancestor-a', rootWallet: '0xwallet-2', minDepth: 1 },
        { ancestorAddress: '0xancestor-a', rootWallet: '0xwallet-3', minDepth: 1 },
      ]),
      replaceRootEdges: vi.fn<FundingEdgeStore['replaceRootEdges']>().mockResolvedValue(undefined),
    } satisfies FundingEdgeStore;
    const setFundingClusterAssignments = vi.fn<WalletStore['setFundingClusterAssignments']>().mockResolvedValue(undefined);
    const walletStore = {
      upsertWalletStub: vi.fn<WalletStore['upsertWalletStub']>(),
      getAggregateStats: vi.fn<WalletStore['getAggregateStats']>(),
      getSignalContext: vi.fn<WalletStore['getSignalContext']>().mockResolvedValue({
        isWhitelisted: false,
        fundingClusterId: 'fc:old',
        fundingGraphBuiltAt: null,
        controllerAddress: null,
      }),
      upsertLiveProfile: vi.fn<WalletStore['upsertLiveProfile']>(),
      updateFundingGraphBuiltAt: vi.fn<WalletStore['updateFundingGraphBuiltAt']>(),
      setFundingClusterAssignments,
      listFundingClusterMembers: vi
        .fn<WalletStore['listFundingClusterMembers']>()
        .mockImplementation(async (clusterId) => (clusterId === 'fc:old' ? ['0xroot'] : [])),
    } satisfies WalletStore;

    const result = await executeFundingGraphRebuild({
      walletAddress: '0xRoot',
      builder,
      fundingEdgeStore,
      walletStore,
      config: makeConfig(),
    });

    expect(result.walletAddress).toBe('0xroot');
    expect(result.edgeCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.fundingClusterId).toMatch(/^fc:/);
    expect(setFundingClusterAssignments).toHaveBeenCalledWith([
      {
        address: '0xroot',
        fundingClusterId: expect.stringMatching(/^fc:/),
      },
      {
        address: '0xwallet-2',
        fundingClusterId: expect.stringMatching(/^fc:/),
      },
      {
        address: '0xwallet-3',
        fundingClusterId: expect.stringMatching(/^fc:/),
      },
    ]);
  });

  it('clears the previous cluster assignment when no cluster candidate remains', async () => {
    const builder = {
      buildGraph: vi.fn<AlchemyFundingGraphBuilder['buildGraph']>().mockResolvedValue({
        edges: [],
        truncated: false,
      }),
    } as unknown as AlchemyFundingGraphBuilder;
    const fundingEdgeStore = {
      listEdgesForRoot: vi.fn<FundingEdgeStore['listEdgesForRoot']>().mockResolvedValue([]),
      listAncestorMemberships: vi.fn<FundingEdgeStore['listAncestorMemberships']>().mockResolvedValue([]),
      replaceRootEdges: vi.fn<FundingEdgeStore['replaceRootEdges']>().mockResolvedValue(undefined),
    } satisfies FundingEdgeStore;
    const setFundingClusterAssignments = vi.fn<WalletStore['setFundingClusterAssignments']>().mockResolvedValue(undefined);
    const walletStore = {
      upsertWalletStub: vi.fn<WalletStore['upsertWalletStub']>(),
      getAggregateStats: vi.fn<WalletStore['getAggregateStats']>(),
      getSignalContext: vi.fn<WalletStore['getSignalContext']>().mockResolvedValue({
        isWhitelisted: false,
        fundingClusterId: 'fc:old',
        fundingGraphBuiltAt: null,
        controllerAddress: null,
      }),
      upsertLiveProfile: vi.fn<WalletStore['upsertLiveProfile']>(),
      updateFundingGraphBuiltAt: vi.fn<WalletStore['updateFundingGraphBuiltAt']>(),
      setFundingClusterAssignments,
      listFundingClusterMembers: vi
        .fn<WalletStore['listFundingClusterMembers']>()
        .mockResolvedValue(['0xroot', '0xwallet-2']),
    } satisfies WalletStore;

    const result = await executeFundingGraphRebuild({
      walletAddress: '0xRoot',
      builder,
      fundingEdgeStore,
      walletStore,
      config: makeConfig(),
    });

    expect(result.fundingClusterId).toBeNull();
    expect(setFundingClusterAssignments).toHaveBeenCalledWith([
      {
        address: '0xroot',
        fundingClusterId: null,
      },
      {
        address: '0xwallet-2',
        fundingClusterId: null,
      },
    ]);
  });
});
