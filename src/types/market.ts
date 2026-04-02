export interface MarketInfo {
  id: string;
  eventSlug: string | null;
  question: string;
  marketSlug: string | null;
  dailyVolumeUsd: string;
  volumeUsd: string;
  liquidityUsd: string;
}
