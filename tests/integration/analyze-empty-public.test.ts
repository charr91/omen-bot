import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPhase0Analysis } from '../../src/phase0/analyze.js';

describe('phase0 analysis without public trade log', () => {
  it('produces a zero-count summary when public-trades.jsonl is missing', async () => {
    const runDirectory = await mkdtemp(resolve(tmpdir(), 'omen-phase0-empty-'));
    const rawDirectory = resolve(runDirectory, 'raw');
    const analysisDirectory = resolve(runDirectory, 'analysis');

    await mkdir(rawDirectory, { recursive: true });
    await mkdir(analysisDirectory, { recursive: true });
    await writeFile(
      resolve(runDirectory, 'manifest.json'),
      `${JSON.stringify(
        {
          version: 'phase0-v0',
          startedAt: '2026-03-28T00:00:00.000Z',
          completedAt: '2026-03-28T00:01:00.000Z',
          runDirectory,
          requestedHours: 0.01,
          useAuth: false,
          sources: {
            gammaMarkets: 'https://gamma-api.polymarket.com/markets?active=true&closed=false',
            publicTrades: 'https://data-api.polymarket.com/trades?limit=500&offset=0&takerOnly=true',
            orderBooks: 'https://clob.polymarket.com/books',
            marketWebSocket: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
            authenticatedTrades: false,
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
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const result = await runPhase0Analysis(runDirectory);

    expect(result.summary.counts.publicTradeObservations).toBe(0);
    expect(result.summary.candidateKeys.txAsset.totalRecords).toBe(0);
    expect(result.summary.recommendation.naturalKey).toBe('TX_HASH_ASSET');
  });
});
