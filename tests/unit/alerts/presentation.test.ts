import { describe, expect, it } from 'vitest';
import {
  formatAlertHeadline,
  getAlertTierAnsiCodes,
  getAlertTierColor,
  getAlertTierEmoji,
} from '../../../src/alerts/presentation.js';
import type { PromotedAlertTier } from '../../../src/types/alert.js';
import { SignalId } from '../../../src/types/signal.js';

const TIER_CASES: Array<{
  tier: PromotedAlertTier;
  emoji: string;
  color: number;
  ansiCodes: string[];
}> = [
  {
    tier: 'CRITICAL',
    emoji: '🚨',
    color: 0xe74c3c,
    ansiCodes: ['1', '37', '41'],
  },
  {
    tier: 'HIGH',
    emoji: '⚠️',
    color: 0xf39c12,
    ansiCodes: ['1', '30', '43'],
  },
  {
    tier: 'MEDIUM',
    emoji: '🔵',
    color: 0x3498db,
    ansiCodes: ['1', '37', '44'],
  },
  {
    tier: 'LOW',
    emoji: '⚪',
    color: 0x7f8c8d,
    ansiCodes: ['2', '37', '100'],
  },
];

describe('alert presentation', () => {
  it.each(TIER_CASES)('exposes stable metadata for $tier', ({ tier, emoji, color, ansiCodes }) => {
    expect(getAlertTierEmoji(tier)).toBe(emoji);
    expect(getAlertTierColor(tier)).toBe(color);
    expect(getAlertTierAnsiCodes(tier)).toEqual(ansiCodes);
  });

  it.each(TIER_CASES)('formats headlines for $tier', ({ tier, emoji }) => {
    expect(formatAlertHeadline(tier, SignalId.LUMP_ENTRY)).toBe(`${emoji} ${tier} | LUMP_ENTRY`);
    expect(formatAlertHeadline(tier)).toBe(`${emoji} ${tier} OMEN ALERT`);
  });
});
