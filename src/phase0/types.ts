export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {}

export type OrderTypeInference = 'TAKER' | 'MAKER' | 'UNKNOWN';
export type TradeSide = 'BUY' | 'SELL' | 'UNKNOWN';

export interface ActiveAsset {
  assetId: string;
  conditionId: string;
  marketSlug: string | null;
  question: string;
  outcome: string | null;
}

export interface ActiveMarket {
  conditionId: string;
  eventSlug: string | null;
  marketSlug: string | null;
  question: string;
  dailyVolumeUsd: string;
  /** Sports kickoff (ISO), from Gamma gameStartTime or the event startTime; null for non-game markets. */
  gameStartTime?: string | null;
  volumeUsd: string;
  liquidityUsd: string;
}

export interface CaptureManifest {
  version: string;
  startedAt: string;
  completedAt: string | null;
  runDirectory: string;
  requestedHours: number;
  useAuth: boolean;
  sources: {
    gammaMarkets: string;
    publicTrades: string;
    orderBooks: string;
    marketWebSocket: string;
    authenticatedTrades: boolean;
  };
  discovery: {
    activeAssets: number;
    activeMarkets: number;
  };
  counts: {
    publicTradeObservations: number;
    orderBookSnapshots: number;
    wsMessages: number;
    authTradeObservations: number;
  };
}

export type CaptureRunStatus = 'running' | 'completed' | 'failed';

export interface CaptureRunState {
  version: string;
  status: CaptureRunStatus;
  runDirectory: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  requestedHours: number;
  useAuth: boolean;
  pid: number;
  resumedFromExisting: boolean;
  counts: CaptureManifest['counts'];
  lastStep: string;
  lastError: string | null;
}

export interface JsonLineEnvelope {
  source: string;
  capturedAt: string;
  pollId?: number;
  payload: JsonObject;
}

export interface PublicTrade {
  observationKey: string;
  walletAddress: string | null;
  transactionHash: string | null;
  assetId: string;
  conditionId: string | null;
  side: TradeSide;
  price: number;
  size: number | null;
  timestampMs: number;
  outcome: string | null;
}

export interface AuthTrade {
  id: string;
  transactionHash: string | null;
  assetId: string;
  marketId: string | null;
  side: TradeSide;
  price: number;
  size: number | null;
  matchTimeMs: number;
  bucketIndex: number | null;
  traderSide: OrderTypeInference;
}

export interface OrderBookLevel {
  price: number;
  size: number | null;
}

export interface OrderBookSnapshot {
  assetId: string;
  marketId: string | null;
  timestampMs: number;
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number | null;
  source: 'rest-book' | 'ws-book';
}

export interface CandidateKeyStats {
  totalRecords: number;
  uniqueKeys: number;
  collisionGroups: number;
  maxGroupSize: number;
  sampleCollisions: Array<{
    key: string;
    count: number;
  }>;
}

export interface OrderTypeSummary {
  inferred: number;
  unknown: number;
  taker: number;
  maker: number;
}

export interface AuthAccuracySummary {
  compared: number;
  matched: number;
  mismatched: number;
  accuracy: number | null;
}

export interface AnalysisSummary {
  version: string;
  runDirectory: string;
  counts: {
    publicTradeObservations: number;
    publicUniqueTrades: number;
    publicDuplicateObservations: number;
    authTradeObservations: number;
    authUniqueTrades: number;
    orderBookSnapshots: number;
    wsMessages: number;
  };
  candidateKeys: {
    txAsset: CandidateKeyStats;
    txAssetPrice: CandidateKeyStats;
    authTradeId: CandidateKeyStats | null;
    authReconciliationComposite: CandidateKeyStats | null;
  };
  findings: {
    sameTxSameAssetRepeats: number;
    sameTxSameAssetDifferentPrice: number;
    logicalTradesSplitAcrossTransactions: number;
  };
  orderTypeInference: {
    publicTrades: OrderTypeSummary;
    authTrades: OrderTypeSummary | null;
    authAccuracy: AuthAccuracySummary | null;
  };
  recommendation: {
    naturalKey: 'AUTH_TRADE_ID' | 'TX_HASH_ASSET' | 'TX_HASH_ASSET_PRICE' | 'UNRESOLVED';
    rationale: string[];
  };
}
