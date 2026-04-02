import type { WalletChainProfile } from '../types/wallet.js';

export interface WalletProfilerLike {
  profileWallet(address: string): Promise<WalletChainProfile>;
}

export interface ResolvedWalletChainProfile {
  profile: WalletChainProfile;
  degraded: boolean;
  error: string | null;
}

export async function resolveWalletChainProfile(options: {
  walletAddress: string;
  profiler: WalletProfilerLike;
}): Promise<ResolvedWalletChainProfile> {
  try {
    return {
      profile: await options.profiler.profileWallet(options.walletAddress),
      degraded: false,
      error: null,
    };
  } catch (error) {
    return {
      profile: buildConservativeChainProfile(),
      degraded: true,
      error: formatError(error),
    };
  }
}

export function buildConservativeChainProfile(): WalletChainProfile {
  return {
    ageSeconds: 0,
    activityAgeKnown: false,
    totalTransactions: 0,
    isContract: false,
    controllerAddress: null,
    freshnessAgeSeconds: 0,
    freshnessActivityAgeKnown: false,
    freshnessTotalTransactions: 0,
    firstActivityAt: null,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
