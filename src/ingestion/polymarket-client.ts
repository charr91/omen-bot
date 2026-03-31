import { randomUUID } from 'node:crypto';
import { canonicalizeEvmAddress } from '../evm/address.js';
import { PUBLIC_TRADE_POLL_LIMIT } from '../phase0/constants.js';
import { fetchPublicTrades } from '../phase0/public-api.js';
import { getNumber, getString, normalizeSide, parseTimestampMs, stableObservationKey } from '../phase0/json.js';
import type { FillCursor } from '../persistence/queries/fills.js';
import type { JsonObject } from '../phase0/types.js';
import type { FillOutcome, NewFill } from '../types/fill.js';

export interface FillSource {
  listRecentFills(cursor: FillCursor | null): Promise<NewFill[]>;
}

interface ListRecentFillsOptions {
  cursor: FillCursor | null;
  maxPagesPerPoll: number;
  fetchPage?: (offset: number) => Promise<JsonObject[]>;
}

export function createPolymarketFillSource(maxPagesPerPoll: number): FillSource {
  return {
    listRecentFills: (cursor) =>
      listRecentFills({
        cursor,
        maxPagesPerPoll,
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

      const fill = normalizeTradeToFill(trade);
      if (!fill) {
        continue;
      }

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

    if (page.length < PUBLIC_TRADE_POLL_LIMIT || pageAllOlderThanCursor) {
      break;
    }

    if (pageIndex === options.maxPagesPerPoll - 1 && pageContainsCursorOrNewer) {
      throw new Error(
        `Public trade polling exceeded configured max_pages_per_poll ${options.maxPagesPerPoll}; refusing to continue with possible silent fill loss.`,
      );
    }
  }

  fills.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  return fills;
}

export function normalizeTradeToFill(trade: JsonObject): NewFill | null {
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
    return null;
  }

  const timestamp = new Date(parseTimestampMs(timestampRaw));
  return {
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
