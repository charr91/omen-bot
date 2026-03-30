import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPhase0Analysis } from '../../src/phase0/analyze.js';

describe('phase0 fixture analysis', () => {
  it('falls back to the strongest public key when auth evidence is too sparse', async () => {
    const fixtureDirectory = resolve(process.cwd(), 'tests/fixtures/phase0-sample-run');
    const tempDirectory = await mkdtemp(resolve(tmpdir(), 'omen-phase0-'));

    await cp(fixtureDirectory, tempDirectory, { recursive: true });

    const result = await runPhase0Analysis(tempDirectory);

    expect(result.summary.candidateKeys.txAsset.collisionGroups).toBe(1);
    expect(result.summary.candidateKeys.txAssetPrice.collisionGroups).toBe(0);
    expect(result.summary.findings.logicalTradesSplitAcrossTransactions).toBe(1);
    expect(result.summary.recommendation.naturalKey).toBe('TX_HASH_ASSET_PRICE');
    expect(result.summary.recommendation.rationale).toContain(
      'Authenticated trade IDs were unique, but only 2 auth trades were captured; require at least 10 before preferring auth IDs over public keys.',
    );
  });

  it('prefers authenticated trade ids once the sample is large enough', async () => {
    const fixtureDirectory = resolve(process.cwd(), 'tests/fixtures/phase0-sample-run');
    const tempDirectory = await mkdtemp(resolve(tmpdir(), 'omen-phase0-auth-'));
    const manifestPath = resolve(tempDirectory, 'manifest.json');
    const authTradesPath = resolve(tempDirectory, 'raw/auth-trades.jsonl');

    await cp(fixtureDirectory, tempDirectory, { recursive: true });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      counts: {
        authTradeObservations: number;
      };
    };
    manifest.counts.authTradeObservations = 10;

    const authTrades = Array.from({ length: 10 }, (_, index) =>
      JSON.stringify({
        source: 'auth-trade',
        capturedAt: `2026-03-28T00:00:${30 + index}.000Z`,
        pollId: 1,
        payload: {
          id: `auth-trade-${index + 1}`,
          transaction_hash: `0xtx-auth-${index + 1}`,
          asset_id: 'asset-yes',
          market: 'market-1',
          side: 'BUY',
          size: '100',
          price: '0.52',
          match_time: '1710000002',
          last_update: `${1710000003 + index}`,
          bucket_index: 9,
          trader_side: 'TAKER',
          outcome: 'Yes',
          maker_address: '0xmaker',
        },
      }),
    ).join('\n');

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(authTradesPath, `${authTrades}\n`, 'utf8');

    const result = await runPhase0Analysis(tempDirectory);

    expect(result.summary.candidateKeys.authTradeId?.collisionGroups).toBe(0);
    expect(result.summary.candidateKeys.authTradeId?.totalRecords).toBe(10);
    expect(result.summary.recommendation.naturalKey).toBe('AUTH_TRADE_ID');
  });
});
