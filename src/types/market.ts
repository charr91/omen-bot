export interface MarketInfo {
  id: string;
  eventSlug: string | null;
  question: string;
  marketSlug: string | null;
  dailyVolumeUsd: string;
  /** Sports kickoff (ISO); fills after it are in-play. */
  gameStartTime?: string | null;
  /** Where dailyVolumeUsd came from (gamma, or the market's own 24h trade tape when that is larger). */
  dailyVolumeSource?: 'gamma' | 'trades';
  volumeUsd: string;
  liquidityUsd: string;
}
