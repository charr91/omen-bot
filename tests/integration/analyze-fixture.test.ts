import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPhase0Analysis } from '../../src/phase0/analyze.js';

describe('phase0 fixture analysis', () => {
  it('produces a recommendation from the committed sample fixture', async () => {
    const fixtureDirectory = resolve(process.cwd(), 'tests/fixtures/phase0-sample-run');
    const tempDirectory = await mkdtemp(resolve(tmpdir(), 'omen-phase0-'));

    await cp(fixtureDirectory, tempDirectory, { recursive: true });

    const result = await runPhase0Analysis(tempDirectory);

    expect(result.summary.candidateKeys.txAsset.collisionGroups).toBe(1);
    expect(result.summary.candidateKeys.txAssetPrice.collisionGroups).toBe(0);
    expect(result.summary.findings.logicalTradesSplitAcrossTransactions).toBe(1);
    expect(result.summary.recommendation.naturalKey).toBe('AUTH_TRADE_ID');
  });
});
