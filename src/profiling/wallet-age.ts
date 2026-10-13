import type { WalletChainProfile } from '../types/wallet.js';

/**
 * Wallet age/activity from every source we have, not just the chain profile.
 *
 * - The on-chain first transfer (proxy or controller) is the only *complete* history, so it is the only source that
 *   can prove a wallet is fresh.
 * - Funding-graph edges into the wallet and omen's own first-seen fill are partial: they bound the age from below
 *   (the wallet existed then), so they can make a wallet older, never fresher.
 * - With no on-chain first activity, age is "known" only when that lower bound already rules freshness out; otherwise
 *   it stays unknown and fresh-wallet does not fire on missing data.
 */
export interface WalletAgeEvidence {
  chain: WalletChainProfile;
  /** Earliest funding edge into this wallet (depth-1 deposit). */
  fundingFirstAt: Date | null;
  fundingInboundCount: number;
  /** omen's first-seen fill for this wallet. */
  firstSeenAt: Date | null;
  /** Fills before (and including) this one. */
  priorFills: number;
  now: Date;
  /** Age at or above which a wallet is not fresh (fresh-wallet elevated window). */
  freshWindowHours: number;
}

export function deriveWalletAge(evidence: WalletAgeEvidence): WalletChainProfile {
  const { chain, now } = evidence;
  const chainFirst = chain.activityAgeKnown ? chain.firstActivityAt : null;
  const candidates = [chainFirst, evidence.fundingFirstAt, evidence.firstSeenAt].filter(
    (d): d is Date => d instanceof Date && Number.isFinite(d.getTime()) && d.getTime() <= now.getTime(),
  );
  const earliest = candidates.length > 0 ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
  const ageSeconds = earliest ? Math.max(0, Math.floor((now.getTime() - earliest.getTime()) / 1000)) : 0;
  const provenOld = ageSeconds >= evidence.freshWindowHours * 3600;
  const known = chainFirst !== null || provenOld;
  const totalTransactions = Math.max(chain.totalTransactions, evidence.priorFills, evidence.fundingInboundCount);
  const freshnessTx = Math.max(chain.freshnessTotalTransactions, evidence.priorFills, evidence.fundingInboundCount);
  return {
    ...chain,
    ageSeconds: known ? ageSeconds : 0,
    activityAgeKnown: known,
    totalTransactions,
    freshnessAgeSeconds: known ? ageSeconds : 0,
    freshnessActivityAgeKnown: known,
    freshnessTotalTransactions: freshnessTx,
    firstActivityAt: known ? earliest : null,
  };
}

/** Proxy + controller: the earliest known first activity of either, and the larger transaction count. */
export function mergeProxyAndController(proxy: WalletChainProfile, controller: WalletChainProfile, controllerAddress: string): WalletChainProfile {
  const firsts = [proxy, controller]
    .filter((p) => p.activityAgeKnown && p.firstActivityAt !== null)
    .map((p) => p.firstActivityAt!.getTime());
  const first = firsts.length > 0 ? new Date(Math.min(...firsts)) : null;
  const age = Math.max(proxy.activityAgeKnown ? proxy.ageSeconds : 0, controller.activityAgeKnown ? controller.ageSeconds : 0);
  const tx = Math.max(proxy.totalTransactions, controller.totalTransactions);
  return {
    ageSeconds: first ? age : 0,
    activityAgeKnown: first !== null,
    totalTransactions: tx,
    isContract: true,
    controllerAddress,
    freshnessAgeSeconds: first ? age : 0,
    freshnessActivityAgeKnown: first !== null,
    freshnessTotalTransactions: Math.max(proxy.freshnessTotalTransactions, controller.freshnessTotalTransactions),
    firstActivityAt: first,
  };
}
