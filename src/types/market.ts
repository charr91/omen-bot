export interface MarketInfo {
  id: string;
  eventSlug: string | null;
  question: string;
  marketSlug: string | null;
  dailyVolumeUsd: string;
  /** Sports kickoff (ISO); fills after it are in-play. */
  gameStartTime?: string | null;
  /** Gamma metadata (market category, else the event's); null/absent when Gamma omitted it. */
  category?: string | null;
  /** Gamma tag slugs + labels, lowercased (include_tag=true). */
  tags?: string[];
  /** Gamma `sportsMarketType` (moneyline, spreads, ...): only set on sports markets. */
  sportsMarketType?: string | null;
  /** Where dailyVolumeUsd came from (gamma, or the market's own 24h trade tape when that is larger). */
  dailyVolumeSource?: 'gamma' | 'trades';
  volumeUsd: string;
  liquidityUsd: string;
}
