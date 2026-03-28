import { describe, expect, it } from 'vitest';
import {
  buildCandidateKeyStats,
  inferTradeType,
  normalizeAuthTrade,
  normalizePublicTrade,
  normalizeRestBook,
  normalizeWsBook,
} from '../../../src/phase0/analyze.js';

describe('phase0 analyze helpers', () => {
  it('normalizes public trade observations into a stable key', () => {
    const trade = normalizePublicTrade({
      source: 'data-api-trade',
      capturedAt: '2026-03-28T00:00:00.000Z',
      pollId: 1,
      payload: {
        proxyWallet: '0xabc',
        transactionHash: '0xtx1',
        asset: 'asset-1',
        conditionId: 'market-1',
        side: 'BUY',
        price: 0.52,
        size: 100,
        timestamp: 1_710_000_000,
        outcome: 'Yes',
      },
    });

    expect(trade.assetId).toBe('asset-1');
    expect(trade.transactionHash).toBe('0xtx1');
    expect(trade.timestampMs).toBe(1_710_000_000_000);
    expect(trade.observationKey).toContain('0xtx1');
  });

  it('normalizes authenticated trade payloads including trader side', () => {
    const trade = normalizeAuthTrade({
      source: 'auth-trade',
      capturedAt: '2026-03-28T00:00:00.000Z',
      payload: {
        id: 'trade-1',
        transaction_hash: '0xtx-auth',
        asset_id: 'asset-1',
        market: 'market-1',
        side: 'BUY',
        price: '0.52',
        size: '100',
        match_time: '1710000000',
        bucket_index: 7,
        trader_side: 'TAKER',
      },
    });

    expect(trade.id).toBe('trade-1');
    expect(trade.bucketIndex).toBe(7);
    expect(trade.traderSide).toBe('TAKER');
    expect(trade.matchTimeMs).toBe(1_710_000_000_000);
  });

  it('infers taker and maker trades from the latest pre-trade book', () => {
    const books = new Map([
      [
        'asset-1',
        [
          {
            assetId: 'asset-1',
            marketId: 'market-1',
            timestampMs: 1_710_000_000_000,
            bestBid: 0.48,
            bestAsk: 0.52,
            tickSize: 0.01,
            source: 'rest-book' as const,
          },
        ],
      ],
    ]);

    expect(inferTradeType('asset-1', 1_710_000_005_000, 'BUY', 0.52, books)).toBe('TAKER');
    expect(inferTradeType('asset-1', 1_710_000_005_000, 'SELL', 0.52, books)).toBe('MAKER');
    expect(inferTradeType('asset-1', 1_710_000_050_000, 'BUY', 0.52, books)).toBe('UNKNOWN');
  });

  it('reports collisions for candidate keys', () => {
    const stats = buildCandidateKeyStats(['a', 'a', 'b', 'c', 'c', 'c']);
    expect(stats.totalRecords).toBe(6);
    expect(stats.uniqueKeys).toBe(3);
    expect(stats.collisionGroups).toBe(2);
    expect(stats.maxGroupSize).toBe(3);
  });

  it('normalizes compact stored orderbook snapshots', () => {
    const snapshot = normalizeRestBook({
      asset_id: 'asset-1',
      market: 'market-1',
      timestamp: '1710000000',
      best_bid: 0.48,
      best_ask: 0.52,
      tick_size: 0.01,
    });

    expect(snapshot?.bestBid).toBe(0.48);
    expect(snapshot?.bestAsk).toBe(0.52);
    expect(snapshot?.timestampMs).toBe(1_710_000_000_000);
  });

  it('normalizes compact websocket book snapshots', () => {
    const snapshot = normalizeWsBook({
      event_type: 'book',
      asset_id: 'asset-1',
      market: 'market-1',
      timestamp: '1710000001',
      best_bid: 0.49,
      best_ask: 0.51,
      tick_size: 0.01,
      source: 'ws-book',
    });

    expect(snapshot?.bestBid).toBe(0.49);
    expect(snapshot?.bestAsk).toBe(0.51);
    expect(snapshot?.timestampMs).toBe(1_710_000_001_000);
  });
});
