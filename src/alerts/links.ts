const POLYMARKET_EVENT_BASE_URL = 'https://polymarket.com/event/';
const POLYGONSCAN_ADDRESS_BASE_URL = 'https://polygonscan.com/address/';

export function buildPolymarketMarketUrl(eventSlug: string | null, marketSlug: string | null): string | null {
  const normalizedEventSlug = normalizeSlugSegment(eventSlug);
  const normalizedMarketSlug = normalizeSlugSegment(marketSlug);

  if (!normalizedEventSlug && !normalizedMarketSlug) {
    return null;
  }

  if (!normalizedEventSlug) {
    return new URL(encodeURIComponent(normalizedMarketSlug!), POLYMARKET_EVENT_BASE_URL).toString();
  }

  if (!normalizedMarketSlug || normalizedEventSlug === normalizedMarketSlug) {
    return new URL(encodeURIComponent(normalizedEventSlug), POLYMARKET_EVENT_BASE_URL).toString();
  }

  return new URL(
    `${encodeURIComponent(normalizedEventSlug)}/${encodeURIComponent(normalizedMarketSlug)}`,
    POLYMARKET_EVENT_BASE_URL,
  ).toString();
}

export function buildPolygonscanAddressUrl(walletAddress: string): string {
  return new URL(encodeURIComponent(walletAddress), POLYGONSCAN_ADDRESS_BASE_URL).toString();
}

function normalizeSlugSegment(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
