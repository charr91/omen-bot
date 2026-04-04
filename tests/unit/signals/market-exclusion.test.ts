import { describe, expect, it } from 'vitest';
import { isMarketExcluded } from '../../../src/signals/market-exclusion.js';
import type { MarketInfo } from '../../../src/types/market.js';

function makeMarket(overrides: Partial<MarketInfo> = {}): MarketInfo {
  return {
    id: 'market-1',
    eventSlug: null,
    question: 'Will candidate X win?',
    marketSlug: 'will-candidate-x-win',
    dailyVolumeUsd: '50000.000000',
    volumeUsd: '500000.000000',
    liquidityUsd: '1000.000000',
    ...overrides,
  };
}

describe('isMarketExcluded', () => {
  it('returns false when excludedCategories is empty', () => {
    expect(isMarketExcluded(makeMarket(), {})).toBe(false);
  });

  it('matches keyword in eventSlug', () => {
    const market = makeMarket({ eventSlug: 'weather-new-york-april' });
    expect(isMarketExcluded(market, { weather: ['weather'] })).toBe(true);
  });

  it('matches keyword in marketSlug', () => {
    const market = makeMarket({ marketSlug: 'will-it-rain-tomorrow' });
    expect(isMarketExcluded(market, { weather: ['rain'] })).toBe(true);
  });

  it('matches keyword in question', () => {
    const market = makeMarket({ question: 'What will the temperature be in NYC?' });
    expect(isMarketExcluded(market, { weather: ['temperature'] })).toBe(true);
  });

  it('is case-insensitive', () => {
    const market = makeMarket({ question: 'Will there be a HURRICANE this season?' });
    expect(isMarketExcluded(market, { weather: ['hurricane'] })).toBe(true);
  });

  it('handles null eventSlug and marketSlug gracefully', () => {
    const market = makeMarket({ eventSlug: null, marketSlug: null, question: 'Some question' });
    expect(isMarketExcluded(market, { weather: ['weather'] })).toBe(false);
  });

  it('returns false when no keywords match', () => {
    const market = makeMarket({ question: 'Will the stock price rise?' });
    expect(isMarketExcluded(market, { weather: ['weather', 'rain', 'snow'] })).toBe(false);
  });

  it('matches across multiple categories', () => {
    const market = makeMarket({ question: 'Who will win the Super Bowl?' });
    const excluded = {
      weather: ['weather', 'rain'],
      sports: ['super bowl', 'nfl'],
    };
    expect(isMarketExcluded(market, excluded)).toBe(true);
  });

  it('does not match partial keywords within unrelated words', () => {
    const market = makeMarket({ question: 'Will the brain-computer interface launch?' });
    expect(isMarketExcluded(market, { weather: ['rain'] })).toBe(false);
  });

  it('does not match "rain" inside "ukraine"', () => {
    const market = makeMarket({ question: 'Will Ukraine join the EU by 2030?' });
    expect(isMarketExcluded(market, { weather: ['rain'] })).toBe(false);
  });

  it('matches "rain" as a standalone word', () => {
    const market = makeMarket({ question: 'Will it rain in NYC tomorrow?' });
    expect(isMarketExcluded(market, { weather: ['rain'] })).toBe(true);
  });

  it('matches keyword at word boundary in slug with hyphens', () => {
    const market = makeMarket({ marketSlug: 'will-it-snow-in-denver' });
    expect(isMarketExcluded(market, { weather: ['snow'] })).toBe(true);
  });
});
