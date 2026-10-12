import { describe, expect, it } from 'vitest';
import { extractMonthDays, extractNumbers, scorePair, suggestMatches } from '../../../src/kalshi/match.js';

const pm = (question: string, end = '2026-10-13T16:00:00Z') => ({
  conditionId: `0x${question.length}`, question, endDate: new Date(end), outcomes: ['Yes', 'No'], volume24h: 1,
});
const kx = (title: string, yesSubTitle: string, date = '2026-10-13T21:00:00Z', ticker = 'KX-1') => ({
  ticker, title, yesSubTitle, eventDate: new Date(date), volume24h: 1,
});

describe('kalshi-map suggest matching', () => {
  it('extracts thresholds but not dates or years', () => {
    expect(extractNumbers('Will Bitcoin be above $86,000 on October 13, 2026?')).toEqual(['86000']);
    expect(extractNumbers('Denver 61°F or below on Oct 13')).toEqual(['61']);
    expect(extractMonthDays('on October 13 / 2026-10-14')).toEqual(['10-13', '10-14']);
  });

  it('flags exact equivalent pairs only', () => {
    const exact = scorePair(pm('Will Gavin Newsom win the California governor recall?'), kx('Will Gavin Newsom win the California governor recall?', ''));
    expect(exact.exact).toBe(true);
    const vice = scorePair(pm('Will Marco Rubio win the 2028 US Presidential Election?'), kx('Who will win the 2028 United States vice presidential election?', 'Marco Rubio'));
    expect(vice.exact).toBe(false);
    expect(vice.conflicts).toContain('vice');
    const threshold = scorePair(pm('Will Bitcoin be above $86,000 on October 13?'), kx('Bitcoin price on Oct 13, 2026?', '$88,000 or above'));
    expect(threshold.numbersMatch).toBe(false);
    const date = scorePair(pm('Will Bitcoin be above $86,000 on October 15?'), kx('Bitcoin price on Oct 16, 2026?', '$86,000 or above'));
    expect(date.conflicts).toContain('date');
  });

  it('picks the best candidate per Polymarket market and dedupes', () => {
    const p = pm('Will KT Rolster win the Demacia Cup Global Invitational?');
    const out = suggestMatches([p, p], [
      kx('Will KT Rolster win Demacia Cup Global Invitational?', 'KT Rolster', '2026-10-13T21:00:00Z', 'KT'),
      kx('Will LGD Gaming win Demacia Cup Global Invitational?', 'LGD Gaming', '2026-10-13T21:00:00Z', 'LGD'),
    ], 0.3);
    expect(out).toHaveLength(1);
    expect(out[0]!.kalshi.ticker).toBe('KT');
  });
});
