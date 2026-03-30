import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchVisiblePublicTrades,
  hydrateCaptureRun,
  selectNewPublicTrades,
  stableTradeObservationKey,
} from '../../../src/phase0/capture.js';
import type { ActiveAsset, JsonObject } from '../../../src/phase0/types.js';

function makeTrade(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    proxyWallet: '0xwallet',
    transactionHash: '0xtx-default',
    asset: 'asset-1',
    conditionId: 'market-1',
    side: 'BUY',
    price: 0.52,
    size: 100,
    timestamp: 1_710_000_000,
    ...overrides,
  };
}

describe('phase0 capture helpers', () => {
  it('filters already-known trades and dedupes within the same poll', () => {
    const first = makeTrade({ transactionHash: '0xtx-1' });
    const second = makeTrade({ transactionHash: '0xtx-2' });
    const known = new Set([stableTradeObservationKey(first)]);
    const pollSeenKeys = new Set<string>();

    const result = selectNewPublicTrades([first, second, second], known, pollSeenKeys);

    expect(result).toHaveLength(1);
    expect(result[0]?.trade).toEqual(second);
    expect(pollSeenKeys.size).toBe(1);
  });

  it('stops paginating once it hits a fully-seen page from a prior poll', async () => {
    const first = makeTrade({ transactionHash: '0xtx-1' });
    const second = makeTrade({ transactionHash: '0xtx-2' });
    const third = makeTrade({ transactionHash: '0xtx-3' });

    const known = new Set([
      stableTradeObservationKey(second),
      stableTradeObservationKey(third),
    ]);

    const fetchPage = vi
      .fn<(offset: number) => Promise<JsonObject[]>>()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second, third])
      .mockResolvedValueOnce([makeTrade({ transactionHash: '0xtx-4' })]);

    const result = await fetchVisiblePublicTrades(known, fetchPage, 2);

    expect(result).toHaveLength(1);
    expect(result[0]?.trade).toEqual(first);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2);
  });

  it('fails loudly instead of truncating when the recent trade window exceeds the max offset', async () => {
    const first = makeTrade({ transactionHash: '0xtx-1' });
    const second = makeTrade({ transactionHash: '0xtx-2' });
    const fetchPage = vi
      .fn<(offset: number) => Promise<JsonObject[]>>()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([makeTrade({ transactionHash: '0xtx-3' }), makeTrade({ transactionHash: '0xtx-4' })]);

    await expect(fetchVisiblePublicTrades(new Set<string>(), fetchPage, 2, 2)).rejects.toThrow(
      'Public trade window exceeded max paginable offset 2',
    );
  });

  it('fails loudly when maxOffset is not divisible by pageSize and more full pages remain', async () => {
    const fetchPage = vi
      .fn<(offset: number) => Promise<JsonObject[]>>()
      .mockResolvedValueOnce([makeTrade({ transactionHash: '0xtx-1' }), makeTrade({ transactionHash: '0xtx-2' })])
      .mockResolvedValueOnce([makeTrade({ transactionHash: '0xtx-3' }), makeTrade({ transactionHash: '0xtx-4' })]);

    await expect(fetchVisiblePublicTrades(new Set<string>(), fetchPage, 2, 3)).rejects.toThrow(
      'Public trade window exceeded max paginable offset 3',
    );
  });

  it('hydrates counts and dedupe state from an incomplete capture directory', async () => {
    const runDirectory = await mkdtemp(resolve(tmpdir(), 'omen-phase0-resume-'));
    const rawDirectory = resolve(runDirectory, 'raw');
    const analysisDirectory = resolve(runDirectory, 'analysis');
    await mkdir(rawDirectory, { recursive: true });
    await mkdir(analysisDirectory, { recursive: true });

    await writeFile(
      resolve(runDirectory, 'manifest.json'),
      `${JSON.stringify({
        version: 'phase0-v0',
        startedAt: '2026-03-28T11:08:39.057Z',
        completedAt: null,
        runDirectory,
        requestedHours: 24,
        useAuth: true,
        sources: {
          gammaMarkets: 'https://gamma-api.polymarket.com/markets?active=true&closed=false',
          publicTrades: 'https://data-api.polymarket.com/trades?limit=500&offset=0&takerOnly=true',
          orderBooks: 'https://clob.polymarket.com/books',
          marketWebSocket: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
          authenticatedTrades: true,
        },
        discovery: {
          activeAssets: 0,
          activeMarkets: 0,
        },
        counts: {
          publicTradeObservations: 0,
          orderBookSnapshots: 0,
          wsMessages: 0,
          authTradeObservations: 0,
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const publicTradeOne = makeTrade({ transactionHash: '0xtx-1' });
    const publicTradeTwo = makeTrade({ transactionHash: '0xtx-2' });
    await writeFile(
      resolve(rawDirectory, 'public-trades.jsonl'),
      [
        {
          source: 'data-api-trade',
          capturedAt: '2026-03-28T11:09:00.000Z',
          pollId: 1,
          payload: publicTradeOne,
        },
        {
          source: 'data-api-trade',
          capturedAt: '2026-03-28T11:09:15.000Z',
          pollId: 2,
          payload: publicTradeTwo,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
        .concat('\n'),
      'utf8',
    );
    await writeFile(
      resolve(rawDirectory, 'order-books.jsonl'),
      `${JSON.stringify({
        source: 'clob-book',
        capturedAt: '2026-03-28T11:09:00.000Z',
        pollId: 1,
        payload: { asset_id: 'asset-1', timestamp: '1', best_bid: 0.4, best_ask: 0.6, source: 'rest-book' },
      })}\n`,
      'utf8',
    );
    await writeFile(
      resolve(rawDirectory, 'ws-market.jsonl'),
      [
        {
          source: 'market-ws',
          capturedAt: '2026-03-28T11:09:01.000Z',
          payload: { asset_id: 'asset-1', timestamp: '1', source: 'ws-book' },
        },
        {
          source: 'market-ws',
          capturedAt: '2026-03-28T11:09:02.000Z',
          payload: { asset_id: 'asset-1', timestamp: '2', source: 'ws-book' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
        .concat('\n'),
      'utf8',
    );
    await writeFile(
      resolve(rawDirectory, 'auth-trades.jsonl'),
      [
        {
          source: 'auth-trade',
          capturedAt: '2026-03-28T11:10:00.000Z',
          pollId: 1,
          payload: { id: 'auth-1' },
        },
        {
          source: 'auth-trade',
          capturedAt: '2026-03-28T11:11:00.000Z',
          pollId: 2,
          payload: { id: 'auth-2' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
        .concat('\n'),
      'utf8',
    );

    const assetMetadata: ActiveAsset = {
      assetId: 'asset-1',
      conditionId: 'market-1',
      marketSlug: 'market-1',
      question: 'Question',
      outcome: 'Yes',
    };

    const result = await hydrateCaptureRun(
      runDirectory,
      {
        hours: 24,
        out: runDirectory,
        useAuth: true,
      },
      new Map([[assetMetadata.assetId, assetMetadata]]),
      {
        activeAssets: 1,
        activeMarkets: 1,
      },
    );

    expect(result.resumedFromExisting).toBe(true);
    expect(result.manifest.counts).toEqual({
      publicTradeObservations: 2,
      orderBookSnapshots: 1,
      wsMessages: 2,
      authTradeObservations: 2,
    });
    expect(result.seenAuthTradeIds.has('auth-1')).toBe(true);
    expect(result.seenAuthTradeIds.has('auth-2')).toBe(true);
    expect(result.seenPublicTradeKeys.has(stableTradeObservationKey(publicTradeOne))).toBe(true);
    expect(result.seenPublicTradeKeys.has(stableTradeObservationKey(publicTradeTwo))).toBe(true);
    expect([...result.observedAssets.keys()]).toEqual(['asset-1']);
  });
});
