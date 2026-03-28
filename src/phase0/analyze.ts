import { resolve } from 'node:path';
import {
  ANALYSIS_DIRECTORY_NAME,
  AUTH_TRADES_FILE_NAME,
  FINDINGS_FILE_NAME,
  MANIFEST_FILE_NAME,
  MAX_BOOK_STALENESS_MS,
  ORDER_BOOKS_FILE_NAME,
  PHASE0_VERSION,
  PUBLIC_TRADES_FILE_NAME,
  RAW_DIRECTORY_NAME,
  SUMMARY_FILE_NAME,
  WS_MESSAGES_FILE_NAME,
} from './constants.js';
import { captureManifestSchema } from './manifest.js';
import {
  asJsonObject,
  getJsonArray,
  getJsonObject,
  getNumber,
  getString,
  normalizeSide,
  parseTimestampMs,
  stableObservationKey,
} from './json.js';
import { ensureDirectory, readJsonFile, readJsonLines, writeJsonFile, writeTextFile } from './io.js';
import type {
  AnalysisSummary,
  AuthAccuracySummary,
  AuthTrade,
  CandidateKeyStats,
  JsonLineEnvelope,
  JsonObject,
  OrderBookSnapshot,
  OrderTypeInference,
  OrderTypeSummary,
  PublicTrade,
  TradeSide,
} from './types.js';

export async function runPhase0Analysis(inputDirectory: string): Promise<{
  summary: AnalysisSummary;
  summaryPath: string;
  findingsPath: string;
}> {
  const runDirectory = resolve(inputDirectory);
  const rawDirectory = resolve(runDirectory, RAW_DIRECTORY_NAME);
  const analysisDirectory = resolve(runDirectory, ANALYSIS_DIRECTORY_NAME);

  await ensureDirectory(analysisDirectory);
  captureManifestSchema.parse(await readJsonFile(resolve(runDirectory, MANIFEST_FILE_NAME)));

  const publicTradeObservations = await readJsonLineEnvelopes(resolve(rawDirectory, PUBLIC_TRADES_FILE_NAME));
  const authTradeObservations = await readJsonLineEnvelopes(resolve(rawDirectory, AUTH_TRADES_FILE_NAME), true);
  const orderBookObservations = await readJsonLineEnvelopes(resolve(rawDirectory, ORDER_BOOKS_FILE_NAME), true);
  const wsObservations = await readJsonLineEnvelopes(resolve(rawDirectory, WS_MESSAGES_FILE_NAME), true);

  const normalizedPublicTrades = dedupePublicTrades(publicTradeObservations.map(normalizePublicTrade));
  const normalizedAuthTrades = dedupeAuthTrades(authTradeObservations.map(normalizeAuthTrade));
  const orderBooks = [
    ...orderBookObservations.map((entry) => normalizeRestBook(entry.payload)),
    ...extractWsBooks(wsObservations.map((entry) => entry.payload)),
  ].filter((snapshot): snapshot is OrderBookSnapshot => snapshot !== null);

  const indexedBooks = indexBooksByAsset(orderBooks);

  const publicInference = summarizeInferences(
    normalizedPublicTrades.map((trade) => inferTradeType(trade.assetId, trade.timestampMs, trade.side, trade.price, indexedBooks)),
  );

  const authInferenceResults = normalizedAuthTrades.map((trade) => ({
    inferred: inferTradeType(trade.assetId, trade.matchTimeMs, trade.side, trade.price, indexedBooks),
    actual: trade.traderSide,
  }));

  const authInference =
    normalizedAuthTrades.length === 0
      ? null
      : summarizeInferences(authInferenceResults.map((entry) => entry.inferred));

  const authAccuracy =
    normalizedAuthTrades.length === 0 ? null : summarizeAuthAccuracy(authInferenceResults);

  const txAsset = buildCandidateKeyStats(
    normalizedPublicTrades.map((trade) => stableObservationKey([trade.transactionHash, trade.assetId])),
  );
  const txAssetPrice = buildCandidateKeyStats(
    normalizedPublicTrades.map((trade) =>
      stableObservationKey([trade.transactionHash, trade.assetId, trade.price]),
    ),
  );

  const authTradeId =
    normalizedAuthTrades.length === 0
      ? null
      : buildCandidateKeyStats(normalizedAuthTrades.map((trade) => trade.id));

  const authReconciliationComposite =
    normalizedAuthTrades.length === 0
      ? null
      : buildCandidateKeyStats(
          normalizedAuthTrades.map((trade) =>
            stableObservationKey([trade.matchTimeMs, trade.bucketIndex, trade.assetId]),
          ),
        );

  const sameTxSameAssetDifferentPrice = countSameTxDifferentPrice(normalizedPublicTrades);
  const logicalTradesSplitAcrossTransactions = countLogicalSplitAcrossTransactions(normalizedAuthTrades);
  const recommendation = buildRecommendation({
    txAsset,
    txAssetPrice,
    authTradeId,
    logicalTradesSplitAcrossTransactions,
  });

  const summary: AnalysisSummary = {
    version: PHASE0_VERSION,
    runDirectory,
    counts: {
      publicTradeObservations: publicTradeObservations.length,
      publicUniqueTrades: normalizedPublicTrades.length,
      publicDuplicateObservations: publicTradeObservations.length - normalizedPublicTrades.length,
      authTradeObservations: authTradeObservations.length,
      authUniqueTrades: normalizedAuthTrades.length,
      orderBookSnapshots: orderBooks.filter((snapshot) => snapshot.source === 'rest-book').length,
      wsMessages: wsObservations.length,
    },
    candidateKeys: {
      txAsset,
      txAssetPrice,
      authTradeId,
      authReconciliationComposite,
    },
    findings: {
      sameTxSameAssetRepeats: txAsset.collisionGroups,
      sameTxSameAssetDifferentPrice,
      logicalTradesSplitAcrossTransactions,
    },
    orderTypeInference: {
      publicTrades: publicInference,
      authTrades: authInference,
      authAccuracy,
    },
    recommendation,
  };

  const findingsMarkdown = renderFindings(summary);
  const summaryPath = resolve(analysisDirectory, SUMMARY_FILE_NAME);
  const findingsPath = resolve(analysisDirectory, FINDINGS_FILE_NAME);

  await writeJsonFile(summaryPath, summary);
  await writeFindingsMarkdown(findingsPath, findingsMarkdown);

  return {
    summary,
    summaryPath,
    findingsPath,
  };
}

export function normalizePublicTrade(entry: JsonLineEnvelope): PublicTrade {
  const trade = entry.payload;
  const assetId = getString(trade, ['asset', 'asset_id']);
  const timestampRaw = getNumber(trade, ['timestamp']);
  const price = getNumber(trade, ['price']);

  if (!assetId || timestampRaw === null || price === null) {
    throw new Error('Public trade payload is missing asset, timestamp, or price');
  }

  const transactionHash = getString(trade, ['transactionHash', 'transaction_hash']);
  const walletAddress = getString(trade, ['proxyWallet', 'proxy_wallet']);
  const side = normalizeSide(getString(trade, ['side']));
  const size = getNumber(trade, ['size']);
  const conditionId = getString(trade, ['conditionId', 'condition_id']);
  const outcome = getString(trade, ['outcome']);
  const timestampMs = parseTimestampMs(timestampRaw);

  return {
    observationKey: stableObservationKey([
      walletAddress,
      transactionHash,
      assetId,
      conditionId,
      side,
      price,
      size,
      timestampMs,
    ]),
    walletAddress,
    transactionHash,
    assetId,
    conditionId,
    side,
    price,
    size,
    timestampMs,
    outcome,
  };
}

export function normalizeAuthTrade(entry: JsonLineEnvelope): AuthTrade {
  const trade = entry.payload;
  const id = getString(trade, ['id']);
  const assetId = getString(trade, ['asset_id', 'asset']);
  const matchTimeRaw = getString(trade, ['match_time', 'matchTime']) ?? getNumber(trade, ['match_time', 'matchTime']);
  const price = getNumber(trade, ['price']);

  if (!id || !assetId || matchTimeRaw === null || price === null) {
    throw new Error('Authenticated trade payload is missing id, asset, match_time, or price');
  }

  const bucketIndex = getNumber(trade, ['bucket_index', 'bucketIndex']);

  return {
    id,
    transactionHash: getString(trade, ['transaction_hash', 'transactionHash']),
    assetId,
    marketId: getString(trade, ['market']),
    side: normalizeSide(getString(trade, ['side'])),
    price,
    size: getNumber(trade, ['size']),
    matchTimeMs: parseTimestampMs(matchTimeRaw),
    bucketIndex: bucketIndex === null ? null : Math.trunc(bucketIndex),
    traderSide: normalizeOrderType(getString(trade, ['trader_side', 'traderSide'])),
  };
}

export function normalizeRestBook(book: JsonObject): OrderBookSnapshot | null {
  const assetId = getString(book, ['asset_id', 'asset']);
  const timestampRaw = getString(book, ['timestamp']) ?? getNumber(book, ['timestamp']);

  if (!assetId || timestampRaw === null) {
    return null;
  }

  const compactBestBid = getNumber(book, ['best_bid']);
  const compactBestAsk = getNumber(book, ['best_ask']);
  const bids = compactBestBid === null ? parseLevels(getJsonArray(book, ['bids'])) : [];
  const asks = compactBestAsk === null ? parseLevels(getJsonArray(book, ['asks'])) : [];
  const tickSize = getNumber(book, ['tick_size']);

  return {
    assetId,
    marketId: getString(book, ['market']),
    timestampMs: parseTimestampMs(timestampRaw),
    bestBid: compactBestBid ?? bids[0]?.price ?? null,
    bestAsk: compactBestAsk ?? asks[0]?.price ?? null,
    tickSize,
    source: 'rest-book',
  };
}

export function inferTradeType(
  assetId: string,
  timestampMs: number,
  side: TradeSide,
  price: number,
  booksByAsset: Map<string, OrderBookSnapshot[]>,
): OrderTypeInference {
  const snapshot = findLatestBookSnapshot(booksByAsset.get(assetId) ?? [], timestampMs);
  if (!snapshot || side === 'UNKNOWN' || snapshot.bestBid === null || snapshot.bestAsk === null) {
    return 'UNKNOWN';
  }

  const tolerance = Math.max((snapshot.tickSize ?? 0.001) / 2, 0.001);
  const touchesBestAsk = Math.abs(price - snapshot.bestAsk) <= tolerance;
  const touchesBestBid = Math.abs(price - snapshot.bestBid) <= tolerance;

  if (touchesBestAsk && touchesBestBid) {
    return 'UNKNOWN';
  }

  if (side === 'BUY') {
    if (touchesBestAsk) {
      return 'TAKER';
    }
    if (touchesBestBid) {
      return 'MAKER';
    }
  }

  if (side === 'SELL') {
    if (touchesBestBid) {
      return 'TAKER';
    }
    if (touchesBestAsk) {
      return 'MAKER';
    }
  }

  return 'UNKNOWN';
}

export function buildCandidateKeyStats(keys: string[]): CandidateKeyStats {
  const grouped = new Map<string, number>();
  for (const key of keys) {
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  const collisions = [...grouped.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1]);

  return {
    totalRecords: keys.length,
    uniqueKeys: grouped.size,
    collisionGroups: collisions.length,
    maxGroupSize: collisions[0]?.[1] ?? 1,
    sampleCollisions: collisions.slice(0, 10).map(([key, count]) => ({ key, count })),
  };
}

function dedupePublicTrades(trades: PublicTrade[]): PublicTrade[] {
  return [...new Map(trades.map((trade) => [trade.observationKey, trade])).values()];
}

function dedupeAuthTrades(trades: AuthTrade[]): AuthTrade[] {
  return [...new Map(trades.map((trade) => [trade.id, trade])).values()];
}

function extractWsBooks(payloads: JsonObject[]): Array<OrderBookSnapshot | null> {
  return payloads
    .filter(
      (payload) =>
        getString(payload, ['event_type']) === 'book' || getString(payload, ['source']) === 'ws-book',
    )
    .map((payload) => normalizeWsBook(payload));
}

export function normalizeWsBook(payload: JsonObject): OrderBookSnapshot | null {
  const assetId = getString(payload, ['asset_id', 'asset']);
  const timestampRaw = getString(payload, ['timestamp']) ?? getNumber(payload, ['timestamp']);

  if (!assetId || timestampRaw === null) {
    return null;
  }

  const compactBestBid = getNumber(payload, ['best_bid']);
  const compactBestAsk = getNumber(payload, ['best_ask']);
  const bids = compactBestBid === null ? parseLevels(getJsonArray(payload, ['bids'])) : [];
  const asks = compactBestAsk === null ? parseLevels(getJsonArray(payload, ['asks'])) : [];

  return {
    assetId,
    marketId: getString(payload, ['market']),
    timestampMs: parseTimestampMs(timestampRaw),
    bestBid: compactBestBid ?? bids[0]?.price ?? null,
    bestAsk: compactBestAsk ?? asks[0]?.price ?? null,
    tickSize: getNumber(payload, ['tick_size', 'tickSize']),
    source: 'ws-book',
  };
}

function parseLevels(levels: unknown[] | null): Array<{
  price: number;
  size: number | null;
}> {
  if (!levels) {
    return [];
  }

  return levels
    .map((entry) => asJsonObject(entry, 'order book level'))
    .map((entry) => ({
      price: getNumber(entry, ['price']),
      size: getNumber(entry, ['size']),
    }))
    .filter((entry): entry is { price: number; size: number | null } => entry.price !== null);
}

function indexBooksByAsset(books: OrderBookSnapshot[]): Map<string, OrderBookSnapshot[]> {
  const grouped = new Map<string, OrderBookSnapshot[]>();

  for (const book of books) {
    const existing = grouped.get(book.assetId) ?? [];
    existing.push(book);
    grouped.set(book.assetId, existing);
  }

  for (const snapshots of grouped.values()) {
    snapshots.sort((left, right) => left.timestampMs - right.timestampMs);
  }

  return grouped;
}

function findLatestBookSnapshot(
  snapshots: OrderBookSnapshot[],
  timestampMs: number,
): OrderBookSnapshot | null {
  let low = 0;
  let high = snapshots.length - 1;
  let candidate: OrderBookSnapshot | null = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const snapshot = snapshots[middle];
    if (!snapshot) {
      break;
    }

    if (snapshot.timestampMs <= timestampMs) {
      candidate = snapshot;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (!candidate) {
    return null;
  }

  return timestampMs - candidate.timestampMs <= MAX_BOOK_STALENESS_MS ? candidate : null;
}

function summarizeInferences(inferences: OrderTypeInference[]): OrderTypeSummary {
  const summary: OrderTypeSummary = {
    inferred: 0,
    unknown: 0,
    taker: 0,
    maker: 0,
  };

  for (const inference of inferences) {
    if (inference === 'UNKNOWN') {
      summary.unknown += 1;
      continue;
    }

    summary.inferred += 1;
    if (inference === 'TAKER') {
      summary.taker += 1;
    } else {
      summary.maker += 1;
    }
  }

  return summary;
}

function summarizeAuthAccuracy(
  entries: Array<{
    inferred: OrderTypeInference;
    actual: OrderTypeInference;
  }>,
): AuthAccuracySummary {
  let compared = 0;
  let matched = 0;

  for (const entry of entries) {
    if (entry.inferred === 'UNKNOWN' || entry.actual === 'UNKNOWN') {
      continue;
    }

    compared += 1;
    if (entry.inferred === entry.actual) {
      matched += 1;
    }
  }

  const mismatched = compared - matched;
  return {
    compared,
    matched,
    mismatched,
    accuracy: compared === 0 ? null : matched / compared,
  };
}

function countSameTxDifferentPrice(trades: PublicTrade[]): number {
  const grouped = new Map<string, Set<number>>();
  for (const trade of trades) {
    const key = stableObservationKey([trade.transactionHash, trade.assetId]);
    const prices = grouped.get(key) ?? new Set<number>();
    prices.add(trade.price);
    grouped.set(key, prices);
  }

  return [...grouped.values()].filter((prices) => prices.size > 1).length;
}

function countLogicalSplitAcrossTransactions(trades: AuthTrade[]): number {
  const grouped = new Map<string, Set<string>>();
  for (const trade of trades) {
    const key = stableObservationKey([trade.matchTimeMs, trade.bucketIndex, trade.assetId]);
    const transactionHashes = grouped.get(key) ?? new Set<string>();
    transactionHashes.add(trade.transactionHash ?? 'null');
    grouped.set(key, transactionHashes);
  }

  return [...grouped.values()].filter((hashes) => hashes.size > 1).length;
}

function buildRecommendation(input: {
  txAsset: CandidateKeyStats;
  txAssetPrice: CandidateKeyStats;
  authTradeId: CandidateKeyStats | null;
  logicalTradesSplitAcrossTransactions: number;
}): AnalysisSummary['recommendation'] {
  if (input.authTradeId && input.authTradeId.collisionGroups === 0) {
    const rationale = ['Authenticated trade IDs are unique in the captured sample.'];
    if (input.logicalTradesSplitAcrossTransactions > 0) {
      rationale.push(
        'Logical trade reconciliation shows some trades split across multiple transaction hashes, so reconciliation composites should not replace trade IDs as the row key.',
      );
    }

    return {
      naturalKey: 'AUTH_TRADE_ID',
      rationale,
    };
  }

  if (input.txAsset.collisionGroups === 0) {
    return {
      naturalKey: 'TX_HASH_ASSET',
      rationale: ['No txHash+asset collisions were observed in the captured public sample.'],
    };
  }

  if (input.txAssetPrice.collisionGroups === 0) {
    return {
      naturalKey: 'TX_HASH_ASSET_PRICE',
      rationale: [
        'txHash+asset collisions were observed, but txHash+asset+price eliminated them in the captured public sample.',
      ],
    };
  }

  return {
    naturalKey: 'UNRESOLVED',
    rationale: ['Public-only candidate keys still collide in the captured sample.'],
  };
}

function renderFindings(summary: AnalysisSummary): string {
  const authAccuracyValue = summary.orderTypeInference.authAccuracy?.accuracy ?? null;
  const authAccuracy =
    authAccuracyValue === null
      ? 'n/a'
      : `${(authAccuracyValue * 100).toFixed(1)}%`;

  return `# Phase 0 Findings

- Public observations: ${summary.counts.publicTradeObservations}
- Public unique trades: ${summary.counts.publicUniqueTrades}
- Duplicate public observations across polling windows: ${summary.counts.publicDuplicateObservations}
- Authenticated trades captured: ${summary.counts.authUniqueTrades}
- Order book snapshots available: ${summary.counts.orderBookSnapshots}
- Market WS messages captured: ${summary.counts.wsMessages}

## Candidate Keys

- txHash + asset: ${summary.candidateKeys.txAsset.collisionGroups} collision groups
- txHash + asset + price: ${summary.candidateKeys.txAssetPrice.collisionGroups} collision groups
- auth trade id: ${summary.candidateKeys.authTradeId?.collisionGroups ?? 'n/a'} collision groups
- auth reconciliation composite: ${summary.candidateKeys.authReconciliationComposite?.collisionGroups ?? 'n/a'} collision groups

## Fill Semantics

- Same tx / same asset repeats: ${summary.findings.sameTxSameAssetRepeats}
- Same tx / same asset with different prices: ${summary.findings.sameTxSameAssetDifferentPrice}
- Logical authenticated trades split across multiple tx hashes: ${summary.findings.logicalTradesSplitAcrossTransactions}

## Order-Type Inference

- Public inferred: ${summary.orderTypeInference.publicTrades.inferred}
- Public unknown: ${summary.orderTypeInference.publicTrades.unknown}
- Auth compared: ${summary.orderTypeInference.authAccuracy?.compared ?? 0}
- Auth accuracy: ${authAccuracy}

## Recommendation

- Natural key: ${summary.recommendation.naturalKey}
- Rationale:
${summary.recommendation.rationale.map((reason) => `  - ${reason}`).join('\n')}
`;
}

async function writeFindingsMarkdown(pathname: string, content: string): Promise<void> {
  await writeTextFile(pathname, content);
}

async function readJsonLineEnvelopes(pathname: string, optional = false): Promise<JsonLineEnvelope[]> {
  try {
    return (await readJsonLines(pathname)).map(parseJsonLineEnvelope);
  } catch (error) {
    if (optional && isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

function normalizeOrderType(value: string | null): OrderTypeInference {
  if (value === 'TAKER' || value === 'MAKER') {
    return value;
  }

  return 'UNKNOWN';
}

function parseJsonLineEnvelope(value: unknown): JsonLineEnvelope {
  const envelope = asJsonObject(value, 'jsonl envelope');
  const source = getString(envelope, ['source']);
  const capturedAt = getString(envelope, ['capturedAt']);
  const payload = getJsonObject(envelope, ['payload']);

  if (!source || !capturedAt || !payload) {
    throw new Error('Invalid jsonl envelope');
  }

  const pollId = getNumber(envelope, ['pollId']);

  return {
    source,
    capturedAt,
    pollId: pollId === null ? undefined : pollId,
    payload,
  };
}

function isMissingFileError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException;
  return err.code === 'ENOENT';
}
