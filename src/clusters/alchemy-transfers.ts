import { canonicalizeEvmAddress } from '../evm/address.js';
import type { AppConfig } from '../config/schema.js';
import type { NewFundingEdge } from '../persistence/queries/funding-edges.js';

export interface FundingGraphBuildResult {
  edges: NewFundingEdge[];
  truncated: boolean;
}

export class AlchemyFundingGraphBuilder {
  constructor(private readonly _apiKey: string) {}

  async buildGraph(
    walletAddress: string,
    _config: Pick<AppConfig, 'detection'>,
  ): Promise<FundingGraphBuildResult> {
    canonicalizeEvmAddress(walletAddress);

    // The branch being merged does not yet have the deeper transfer-tracing stack.
    // Keep the cold-path worker operational with a safe no-op graph until that
    // subsystem lands again.
    return {
      edges: [],
      truncated: false,
    };
  }
}
