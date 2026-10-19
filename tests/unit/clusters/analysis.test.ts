import { describe, expect, it } from 'vitest';
import { deriveBestClusterCandidate } from '../../../src/clusters/analysis.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const funder = addr(0xf00d);
const exchange = addr(0xe8c);

function memberships(ancestor: string, count: number, offset: number) {
  return Array.from({ length: count }, (_, i) => ({ ancestorAddress: ancestor, rootWallet: addr(offset + i) }));
}

describe('deriveBestClusterCandidate', () => {
  const root = addr(1);
  const base = {
    rootWallet: root,
    rootEdges: [{ fromAddress: funder }, { fromAddress: exchange }],
    ancestorMemberships: [...memberships(funder, 3, 100), ...memberships(exchange, 80, 1000)],
    minSize: 3,
  };

  it('picks the largest shared-funder group without a size cap', () => {
    expect(deriveBestClusterCandidate(base)?.wallets).toHaveLength(81);
  });

  it('skips high fan-out (exchange / hot wallet) funders above maxSize', () => {
    const candidate = deriveBestClusterCandidate({ ...base, maxSize: 50 });
    expect(candidate?.wallets).toHaveLength(4);
    expect(candidate?.wallets).toContain(root);
  });

  it('skips denylisted funders', () => {
    expect(deriveBestClusterCandidate({ ...base, maxSize: 50, excludedFunders: new Set([funder]) })).toBeNull();
  });
});
