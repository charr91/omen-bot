import { canonicalizeEvmAddress } from '../evm/address.js';
import type { AppConfig } from '../config/schema.js';
import type { FundingEdgeStore } from '../persistence/queries/funding-edges.js';
import type { WalletStore } from '../persistence/queries/wallets.js';
import { deriveBestClusterCandidate } from '../clusters/analysis.js';
import type { AlchemyFundingGraphBuilder } from '../clusters/alchemy-transfers.js';
import {
  COLD_JOB_RELEVANCE_WINDOW_MS,
  decideColdJobSkip,
  type ColdJobRelevanceStore,
  type ColdJobSkipReason,
} from './relevance.js';

export interface FundingGraphRebuildResult {
  walletAddress: string;
  edgeCount: number;
  truncated: boolean;
  fundingClusterId: string | null;
  skipped?: ColdJobSkipReason;
}

export async function executeFundingGraphRebuild(options: {
  walletAddress: string;
  builder: AlchemyFundingGraphBuilder;
  fundingEdgeStore: FundingEdgeStore;
  walletStore: WalletStore;
  config: Pick<AppConfig, 'detection'>;
  /** When set, stale jobs (graph already fresh, or no recent fill >= minFillUsd) complete without Alchemy calls. */
  relevance?: {
    store: ColdJobRelevanceStore;
    minFillUsd: number;
    now?: () => Date;
    budgetExhausted?: () => Promise<boolean>;
  };
}): Promise<FundingGraphRebuildResult> {
  const walletAddress = canonicalizeEvmAddress(options.walletAddress);
  const previousSignalContext = await options.walletStore.getSignalContext(walletAddress);
  if (options.relevance) {
    const now = options.relevance.now?.() ?? new Date();
    const skip = decideColdJobSkip({
      fundingGraphBuiltAt: previousSignalContext.fundingGraphBuiltAt,
      maxRecentFillUsd: await options.relevance.store.getMaxRecentFillUsd(
        walletAddress,
        new Date(now.getTime() - COLD_JOB_RELEVANCE_WINDOW_MS),
      ),
      minFillUsd: options.relevance.minFillUsd,
      now,
    });
    const finalSkip = skip ?? ((await options.relevance.budgetExhausted?.()) ? 'daily-budget' : null);
    if (finalSkip !== null) {
      return {
        walletAddress,
        edgeCount: 0,
        truncated: false,
        fundingClusterId: previousSignalContext.fundingClusterId,
        skipped: finalSkip,
      };
    }
  }
  const builtAt = new Date();
  const buildResult = await options.builder.buildGraph(walletAddress, options.config);
  await options.fundingEdgeStore.replaceRootEdges(walletAddress, buildResult.edges, builtAt);
  await options.walletStore.updateFundingGraphBuiltAt(walletAddress, builtAt);

  const rootEdges = await options.fundingEdgeStore.listEdgesForRoot(walletAddress);
  const candidate =
    rootEdges.length === 0
      ? null
      : deriveBestClusterCandidate({
          rootWallet: walletAddress,
          rootEdges,
          ancestorMemberships: await options.fundingEdgeStore.listAncestorMemberships(
            [...new Set(rootEdges.map((edge) => edge.fromAddress))],
          ),
          minSize: options.config.detection.cluster.minSize,
        });

  await applyClusterAssignments(
    options.walletStore,
    walletAddress,
    previousSignalContext.fundingClusterId,
    candidate?.id ?? null,
    candidate?.wallets ?? [],
  );

  return {
    walletAddress,
    edgeCount: buildResult.edges.length,
    truncated: buildResult.truncated,
    fundingClusterId: candidate?.id ?? null,
  };
}

async function applyClusterAssignments(
  walletStore: WalletStore,
  walletAddress: string,
  previousClusterId: string | null,
  nextClusterId: string | null,
  nextClusterWallets: string[],
): Promise<void> {
  const assignments = new Map<string, string | null>();
  const canonicalNextClusterWallets = [...new Set(nextClusterWallets.map((address) => canonicalizeEvmAddress(address)))];

  if (previousClusterId !== null) {
    for (const address of await walletStore.listFundingClusterMembers(previousClusterId)) {
      assignments.set(address, null);
    }
  }

  if (nextClusterId !== null) {
    for (const address of await walletStore.listFundingClusterMembers(nextClusterId)) {
      if (!canonicalNextClusterWallets.includes(address)) {
        assignments.set(address, null);
      }
    }
    for (const address of canonicalNextClusterWallets) {
      assignments.set(address, nextClusterId);
    }
  } else {
    assignments.set(walletAddress, null);
  }

  await walletStore.setFundingClusterAssignments(
    [...assignments.entries()].map(([address, fundingClusterId]) => ({
      address,
      fundingClusterId,
    })),
  );
}
