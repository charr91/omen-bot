import { randomUUID } from 'node:crypto';
import { canonicalizeEvmAddress } from '../evm/address.js';
import { PUBLIC_TRADE_POLL_LIMIT } from '../phase0/constants.js';
import { fetchPublicTrades } from '../phase0/public-api.js';
import { getNumber, getString, normalizeSide, parseTimestampMs, stableObservationKey } from '../phase0/json.js';
import type { FillCursor } from '../persistence/queries/fills.js';
import type { JsonObject } from '../phase0/types.js';
import type { FillOutcome, NewFill } from '../types/fill.js';

// box-dry-run: process-local dedupe for quarantined trades.
const MAX_RECENT_QUARANTINE_KEYS = 200_000;
const recentQuarantineKeys = new Set<string>();

export interface FillSource {
  listRecentFills(cursor: FillCursor | null): Promise<NewFill[]>;
}

export interface InvalidTradeObservation {
  source: 'polymarket_rest';
  rawPayload: JsonObject;
  failureReason: string;
}

interface ListRecentFillsOptions {
  cursor: FillCursor | null;
  maxPagesPerPoll: number;
  fetchPage?: (offset: number) => Promise<JsonObject[]>;
  onInvalidTrade?: (observation: InvalidTradeObservation) => Promise<void>;
}

export function createPolymarketFillSource(
  maxPagesPerPoll: number,
  options: Pick<ListRecentFillsOptions, 'onInvalidTrade'> = {},
): FillSource {
  return {
      listRecentFills: (cursor) =>
        listRecentFills({
          cursor,
          maxPagesPerPoll,
          onInvalidTrade: options.onInvalidTrade,
        }),
  };
}

export async function listRecentFills(options: ListRecentFillsOptions): Promise<NewFill[]> {
  const fetchPage = options.fetchPage ?? fetchPublicTrades;
  const fills: NewFill[] = [];
  const seenFillKeys = new Set<string>();
  const cursorTimestampMs = options.cursor?.timestamp.getTime() ?? null;
  const seenCursorFillKeys = new Set(options.cursor?.seenFillKeysAtTimestamp ?? []);

  for (let pageIndex = 0; pageIndex < options.maxPagesPerPoll; pageIndex += 1) {
    const offset = pageIndex * PUBLIC_TRADE_POLL_LIMIT;
    let page: JsonObject[];
    try {
      page = await fetchPage(offset);
    } catch (error) {
      if (offset > 0 && error instanceof Error && error.message.includes('400 Bad Request')) {
        break;
      }
      throw error;
    }

    if (page.length === 0) {
      break;
    }

    let pageContainsCursorOrNewer = false;
    let pageAllOlderThanCursor = cursorTimestampMs !== null;

    for (const trade of page) {
      const timestampMs = getTradeTimestampMs(trade);
      if (timestampMs !== null && cursorTimestampMs !== null && timestampMs >= cursorTimestampMs) {
        pageContainsCursorOrNewer = true;
      }
      if (timestampMs === null || cursorTimestampMs === null || timestampMs >= cursorTimestampMs) {
        pageAllOlderThanCursor = false;
      }

      const parsedTrade = parseTradeToFill(trade);
      if (parsedTrade.kind === 'invalid') {
        // box-dry-run: every poll re-reads up to max_pages_per_poll pages, so the same invalid
        // (mostly non-YES/NO outcome) trades were re-quarantined each cycle (~6k rows/min).
        // Skip trades older than the cursor and dedupe within this process.
        if (timestampMs !== null && cursorTimestampMs !== null && timestampMs < cursorTimestampMs) {
          continue;
        }
        const quarantineKey = stableObservationKey([
          getString(trade, ['transactionHash', 'transaction_hash']) ?? '',
          getString(trade, ['asset', 'asset_id']) ?? '',
          String(timestampMs ?? ''),
          parsedTrade.reason,
        ]);
        if (recentQuarantineKeys.has(quarantineKey)) {
          continue;
        }
        recentQuarantineKeys.add(quarantineKey);
        if (recentQuarantineKeys.size > MAX_RECENT_QUARANTINE_KEYS) {
          const oldest = recentQuarantineKeys.values().next().value;
          if (oldest !== undefined) {
            recentQuarantineKeys.delete(oldest);
          }
        }
        await options.onInvalidTrade?.({
          source: 'polymarket_rest',
          rawPayload: trade,
          failureReason: parsedTrade.reason,
        });
        continue;
      }
      const fill = parsedTrade.fill;

      const fillTimestampMs = fill.timestamp.getTime();
      if (cursorTimestampMs !== null && fillTimestampMs < cursorTimestampMs) {
        continue;
      }

      const fillKey = stableObservationKey([fill.txHash, fill.tokenId]);
      if (
        cursorTimestampMs !== null &&
        fillTimestampMs === cursorTimestampMs &&
        seenCursorFillKeys.has(fillKey)
      ) {
        continue;
      }

      if (seenFillKeys.has(fillKey)) {
        continue;
      }

      seenFillKeys.add(fillKey);
      fills.push(fill);
    }

    // box-dry-run: as of Oct 2026 data-api /trades pages are not globally time-ordered (each page is
    // sorted internally but offsets come back shuffled/overlapping, refreshed in ~5 min batches), so
    // stopping at the first all-older page dropped most of each batch, and the max-pages guard is
    // meaningless. Read every page up to max_pages_per_poll; DB dedupes on (tx_hash, token_id).
    void pageAllOlderThanCursor;
    void pageContainsCursorOrNewer;
    if (page.length < PUBLIC_TRADE_POLL_LIMIT) {
      break;
    }
  }

  fills.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  return fills;
}

export function normalizeTradeToFill(trade: JsonObject): NewFill | null {
  const parsedTrade = parseTradeToFill(trade);
  return parsedTrade.kind === 'ok' ? parsedTrade.fill : null;
}

export function parseTradeToFill(trade: JsonObject):
  | { kind: 'ok'; fill: NewFill }
  | { kind: 'invalid'; reason: string } {
  const tokenId = getString(trade, ['asset', 'asset_id']);
  const marketId = getString(trade, ['conditionId', 'condition_id', 'market']);
  const walletAddress = getString(trade, ['proxyWallet', 'proxy_wallet']);
  const txHash = getString(trade, ['transactionHash', 'transaction_hash']);
  const outcome = normalizeOutcome(getString(trade, ['outcome']));
  const side = normalizeSide(getString(trade, ['side']));
  const price = getNumber(trade, ['price']);
  const shares = getNumber(trade, ['size']);
  const timestampRaw = getNumber(trade, ['timestamp']) ?? getString(trade, ['timestamp']);

  if (
    !tokenId ||
    !marketId ||
    !walletAddress ||
    !txHash ||
    !outcome ||
    side === 'UNKNOWN' ||
    price === null ||
    shares === null ||
    price <= 0 ||
    shares <= 0 ||
    timestampRaw === null
  ) {
    return {
      kind: 'invalid',
      reason: buildInvalidTradeReason({
        tokenId,
        marketId,
        walletAddress,
        txHash,
        outcome,
        side,
        price,
        shares,
        timestampRaw,
      }),
    };
  }

  const timestamp = new Date(parseTimestampMs(timestampRaw));
  return {
    kind: 'ok',
    fill: {
      id: randomUUID(),
      marketId,
      tokenId,
      walletAddress: canonicalizeEvmAddress(walletAddress),
      side,
      outcome,
      price: formatNumeric(price),
      shares: formatNumeric(shares),
      sizeUsd: formatNumeric(price * shares),
      txHash,
      orderType: 'UNKNOWN',
      timestamp,
    },
  };
}

function normalizeOutcome(value: string | null): FillOutcome | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === 'YES' || normalized === 'NO') {
    return normalized;
  }

  return null;
}

function getTradeTimestampMs(trade: JsonObject): number | null {
  const raw = getNumber(trade, ['timestamp']) ?? getString(trade, ['timestamp']);
  if (raw === null) {
    return null;
  }

  return parseTimestampMs(raw);
}

function formatNumeric(value: number): string {
  return value.toFixed(6);
}

function buildInvalidTradeReason(input: {
  tokenId: string | null;
  marketId: string | null;
  walletAddress: string | null;
  txHash: string | null;
  outcome: FillOutcome | null;
  side: ReturnType<typeof normalizeSide>;
  price: number | null;
  shares: number | null;
  timestampRaw: number | string | null;
}): string {
  if (!input.tokenId) {
    return 'missing asset/token id';
  }
  if (!input.marketId) {
    return 'missing market/condition id';
  }
  if (!input.walletAddress) {
    return 'missing proxy wallet';
  }
  if (!input.txHash) {
    return 'missing transaction hash';
  }
  if (!input.outcome) {
    return 'missing or invalid outcome';
  }
  if (input.side === 'UNKNOWN') {
    return 'missing or invalid trade side';
  }
  if (input.price === null || input.price <= 0) {
    return 'missing or invalid trade price';
  }
  if (input.shares === null || input.shares <= 0) {
    return 'missing or invalid trade size';
  }
  if (input.timestampRaw === null) {
    return 'missing timestamp';
  }

  return 'invalid trade payload';
}
