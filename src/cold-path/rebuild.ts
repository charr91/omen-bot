import { canonicalizeEvmAddress } from '../evm/address.js';
import type { AppConfig } from '../config/schema.js';
import type { FundingEdgeStore } from '../persistence/queries/funding-edges.js';
import type { WalletStore } from '../persistence/queries/wallets.js';
import { deriveBestClusterCandidate } from '../clusters/analysis.js';
import type { AlchemyFundingGraphBuilder } from '../clusters/alchemy-transfers.js';

export interface FundingGraphRebuildResult {
  walletAddress: string;
  edgeCount: number;
  truncated: boolean;
  fundingClusterId: string | null;
}

export async function executeFundingGraphRebuild(options: {
  walletAddress: string;
  builder: AlchemyFundingGraphBuilder;
  fundingEdgeStore: FundingEdgeStore;
  walletStore: WalletStore;
  config: Pick<AppConfig, 'detection'>;
}): Promise<FundingGraphRebuildResult> {
  const walletAddress = canonicalizeEvmAddress(options.walletAddress);
  const previousSignalContext = await options.walletStore.getSignalContext(walletAddress);
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
