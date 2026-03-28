import { describe, expect, it } from 'vitest';
import { normalizeEpoch, parseTimestampMs } from '../../../src/phase0/json.js';

describe('phase0 json helpers', () => {
  it('normalizes second, millisecond, and microsecond epoch values', () => {
    expect(normalizeEpoch(1_710_000_000)).toBe(1_710_000_000_000);
    expect(normalizeEpoch(1_710_000_000_123)).toBe(1_710_000_000_123);
    expect(normalizeEpoch(1_710_000_000_123_456)).toBe(1_710_000_000_123);
  });

  it('parses numeric timestamp strings using epoch normalization', () => {
    expect(parseTimestampMs('1710000000')).toBe(1_710_000_000_000);
    expect(parseTimestampMs('1710000000123456')).toBe(1_710_000_000_123);
  });
});
