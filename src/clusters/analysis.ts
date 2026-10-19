import { createHash } from 'node:crypto';
import { canonicalizeEvmAddress } from '../evm/address.js';
import type { AncestorMembership, FundingEdge } from '../persistence/queries/funding-edges.js';

export interface FundingClusterCandidate {
  id: string;
  wallets: string[];
}

export function deriveBestClusterCandidate(options: {
  rootWallet: string;
  rootEdges: Pick<FundingEdge, 'fromAddress'>[];
  ancestorMemberships: AncestorMembership[];
  minSize: number;
  /** Ancestors funding more wallets than this are exchange / hot-wallet fan-out, never a cluster. */
  maxSize?: number;
  excludedFunders?: ReadonlySet<string>;
}): FundingClusterCandidate | null {
  const canonicalRootWallet = canonicalizeEvmAddress(options.rootWallet);
  const membershipsByAncestor = new Map<string, Set<string>>();

  for (const membership of options.ancestorMemberships) {
    const ancestorAddress = canonicalizeEvmAddress(membership.ancestorAddress);
    const wallets = membershipsByAncestor.get(ancestorAddress) ?? new Set<string>();
    wallets.add(canonicalizeEvmAddress(membership.rootWallet));
    membershipsByAncestor.set(ancestorAddress, wallets);
  }

  let bestWallets: string[] | null = null;
  for (const rootEdge of options.rootEdges) {
    const ancestorAddress = canonicalizeEvmAddress(rootEdge.fromAddress);
    const wallets = membershipsByAncestor.get(ancestorAddress);
    if (!wallets || options.excludedFunders?.has(ancestorAddress)) {
      continue;
    }

    wallets.add(canonicalRootWallet);
    const candidateWallets = [...wallets].sort();
    if (candidateWallets.length < options.minSize || (options.maxSize !== undefined && candidateWallets.length > options.maxSize)) {
      continue;
    }

    if (
      bestWallets === null ||
      candidateWallets.length > bestWallets.length ||
      (candidateWallets.length === bestWallets.length &&
        candidateWallets.join('|') < bestWallets.join('|'))
    ) {
      bestWallets = candidateWallets;
    }
  }

  if (bestWallets === null) {
    return null;
  }

  return {
    id: buildFundingClusterId(bestWallets),
    wallets: bestWallets,
  };
}

function buildFundingClusterId(wallets: string[]): string {
  return `fc:${createHash('sha256').update(wallets.join('|')).digest('hex').slice(0, 12)}`;
}
