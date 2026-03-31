export interface MarketInfo {
  id: string;
  question: string;
  marketSlug: string | null;
  dailyVolumeUsd: string;
  volumeUsd: string;
  liquidityUsd: string;
}
