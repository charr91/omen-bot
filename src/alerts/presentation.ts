import type {
  AlertLinkedTradeContext,
  PresentableAlert,
  PromotedAlert,
  PromotedAlertTier,
  SignalPreview,
} from '../types/alert.js';
import { SignalId } from '../types/signal.js';

const ALERT_TIER_META = {
  CRITICAL: {
    color: 0xe74c3c,
    emoji: '🚨',
    ansiCodes: ['1', '37', '41'],
  },
  HIGH: {
    color: 0xf39c12,
    emoji: '⚠️',
    ansiCodes: ['1', '30', '43'],
  },
  MEDIUM: {
    color: 0x3498db,
    emoji: '🔵',
    ansiCodes: ['1', '37', '44'],
  },
  LOW: {
    color: 0x7f8c8d,
    emoji: '⚪',
    ansiCodes: ['2', '37', '100'],
  },
} satisfies Record<PromotedAlertTier, { color: number; emoji: string; ansiCodes: string[] }>;

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const PRICE_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

export function getAlertTierColor(tier: PromotedAlertTier): number {
  return ALERT_TIER_META[tier].color;
}

export function getAlertTierEmoji(tier: PromotedAlertTier): string {
  return ALERT_TIER_META[tier].emoji;
}

export function getAlertTierAnsiCodes(tier: PromotedAlertTier): string[] {
  return ALERT_TIER_META[tier].ansiCodes;
}

export function formatAlertHeadline(
  tier: PromotedAlertTier,
  signalId?: PromotedAlert['signal']['signalId'],
): string {
  const emoji = getAlertTierEmoji(tier);
  const prefix = `${emoji ? `${emoji} ` : ''}${tier}`;
  return signalId ? `${prefix} | ${signalId}` : `${prefix} OMEN ALERT`;
}

export function formatAlertTradeAction(
  alert: Pick<PromotedAlert, 'fillOutcome' | 'fillSide'> & { fillPrice?: string | null },
): string {
  if ((alert.fillSide !== 'BUY' && alert.fillSide !== 'SELL') || !alert.fillOutcome) {
    return 'Trade unavailable';
  }

  const base = `${alert.fillSide === 'BUY' ? 'Bought' : 'Sold'} ${alert.fillOutcome}`;
  const price = formatAlertPrice(alert.fillPrice);
  if (price === null) return base;
  if (alert.fillSide === 'SELL') {
    // Selling YES at p is effectively long NO at 1 - p.
    const raw = Number(alert.fillPrice);
    const other = alert.fillOutcome === 'YES' ? 'NO' : 'YES';
    const effective = Number.isFinite(raw) ? formatAlertPrice(String(1 - raw)) : null;
    return effective === null ? `${base} @ ${price}` : `${base} @ ${price} (≈ long ${other} @ ${effective})`;
  }
  return `${base} @ ${price}`;
}

export function getAlertFillSize(
  alert: Pick<PromotedAlert, 'signal'> & { fillSizeUsd?: string | null },
): string | number | undefined {
  if ('fillSizeUsd' in alert && alert.fillSizeUsd !== undefined && alert.fillSizeUsd !== null && alert.fillSizeUsd !== '') {
    return alert.fillSizeUsd;
  }

  return alert.signal.evidence.find((entry) => entry.field === 'fill_size_usd')?.value;
}

export function formatAlertFillSize(
  alert: Pick<PromotedAlert, 'signal'> & { fillSizeUsd?: string | null },
): string {
  return formatUsdValue(getAlertFillSize(alert));
}

export function formatAlertPrice(value?: string | null): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return PRICE_FORMATTER.format(numeric);
  }

  return String(value);
}

export function formatAlertShortWallet(address: string): string {
  if (address.length <= 14) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatAlertScore(
  alert: Pick<PromotedAlert, 'walletLiveScore' | 'walletLiveTier'> | Pick<SignalPreview, 'walletLiveScore' | 'walletLiveTier'>,
): string {
  return `${alert.walletLiveScore} (${alert.walletLiveTier})`;
}

export function formatAlertMeaning(alert: PresentableAlert): string | null {
  switch (alert.signal.signalId) {
    case SignalId.OUTSIZED_POSITION:
      return formatOutsizedPositionMeaning(alert);
    case SignalId.LUMP_ENTRY:
      return formatLumpEntryMeaning(alert);
    case SignalId.NICHE_MARKET_ENTRY:
      return formatNicheMarketEntryMeaning(alert);
    case SignalId.CONVICTION_SIZE_MISMATCH:
      return formatConvictionSizeMismatchMeaning(alert);
    case SignalId.FRESH_WALLET_LARGE_POSITION:
      return formatFreshWalletMeaning(alert);
    case SignalId.SYBIL_CLUSTER:
      return formatSybilClusterMeaning(alert);
    default:
      return null;
  }
}

export function formatLinkedTradeContextSummary(context: AlertLinkedTradeContext): string {
  const latestAction = formatAlertTradeAction({
    fillSide: context.latest.fillSide,
    fillOutcome: context.latest.fillOutcome,
    fillPrice: context.latest.fillPrice,
  });
  return `After ${formatLinkedTradeCount(context)} in this market. Latest: ${latestAction} $${formatUsdValue(
    context.latest.fillSizeUsd,
  )} at ${formatIsoClock(context.latest.fillTimestamp)}`;
}

export function formatLinkedTradeContextCompact(context: AlertLinkedTradeContext): string {
  return `after ${formatLinkedTradeCount(context)}`;
}

export function formatUsdValue(value: string | number | undefined): string {
  if (value === undefined) {
    return 'n/a';
  }

  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) {
    return USD_FORMATTER.format(numeric);
  }

  return String(value);
}

function formatLinkedTradeCount(context: AlertLinkedTradeContext): string {
  const label = context.oppositeSide === 'BUY' ? 'buy' : 'sell';
  return `${context.recentCount} recent ${label}${context.recentCount === 1 ? '' : 's'}`;
}

function formatOutsizedPositionMeaning(alert: PresentableAlert): string {
  const fillSize = getEvidenceValue(alert, 'fill_size_usd');
  const threshold = getEvidenceValue(alert, 'fill_size_usd', 'threshold');
  if (fillSize !== undefined && threshold !== undefined) {
    return `This trade is unusually large for this market: $${formatUsdValue(fillSize)} against a threshold of $${formatUsdValue(threshold)}.`;
  }

  return 'This trade is unusually large for this market.';
}

function formatLumpEntryMeaning(alert: PresentableAlert): string {
  const lumpRatio = getEvidenceValue(alert, 'lump_ratio');
  const priorVolume = getEvidenceValue(alert, 'prior_wallet_total_volume_usd');
  if (lumpRatio !== undefined && priorVolume !== undefined) {
    return `This fill is unusually concentrated for this wallet: about ${formatRatio(lumpRatio)} of its prior lifetime volume of $${formatUsdValue(priorVolume)}.`;
  }

  return "This fill is unusually concentrated relative to the wallet's prior trading history.";
}

function formatNicheMarketEntryMeaning(alert: PresentableAlert): string {
  const fillSize = getEvidenceValue(alert, 'fill_size_usd');
  const marketVolume = getEvidenceValue(alert, 'market_daily_volume_usd');
  if (fillSize !== undefined && marketVolume !== undefined) {
    return `This wallet made a meaningful $${formatUsdValue(fillSize)} entry in a low-volume market doing about $${formatUsdValue(marketVolume)} a day.`;
  }

  return 'This wallet made a meaningful entry in a low-volume market.';
}

function formatConvictionSizeMismatchMeaning(alert: PresentableAlert): string {
  const priorVolume = getEvidenceValue(alert, 'prior_wallet_total_volume_usd');
  const fillSize = getEvidenceValue(alert, 'fill_size_usd');
  const fillPrice = getEvidenceValue(alert, 'fill_price');
  if (priorVolume !== undefined && fillSize !== undefined && fillPrice !== undefined) {
    return `This looks like a relatively small wallet taking a large longshot swing: $${formatUsdValue(fillSize)} at ${formatPriceValue(fillPrice)} against about $${formatUsdValue(priorVolume)} of prior volume.`;
  }

  return 'This looks like a relatively small wallet taking an unusually large longshot bet.';
}

function formatFreshWalletMeaning(alert: PresentableAlert): string {
  const ageHours = getEvidenceValue(alert, 'wallet_age_hours');
  const txCount = getEvidenceValue(alert, 'wallet_total_transactions');
  if (ageHours !== undefined && txCount !== undefined) {
    return `A very fresh wallet, about ${formatPlainNumber(ageHours)} hours old with ${formatPlainNumber(txCount)} transactions, just made a large niche-market trade.`;
  }

  return 'A very fresh, low-activity wallet just made a large trade in a niche market.';
}

function formatSybilClusterMeaning(alert: PresentableAlert): string {
  const clusterSize = getEvidenceValue(alert, 'cluster_size');
  const sameSideEntries = getEvidenceValue(alert, 'same_market_same_side_entries');
  if (clusterSize !== undefined && sameSideEntries !== undefined) {
    return `This wallet appears tied to a shared-funding cluster of ${formatPlainNumber(clusterSize)} wallets with ${formatPlainNumber(sameSideEntries)} same-side entries in this market.`;
  }

  return 'This wallet appears tied to a shared-funding cluster entering the same market around the same time.';
}

function getEvidenceValue(
  alert: PresentableAlert,
  field: string,
  key: 'value' | 'threshold' = 'value',
): string | number | undefined {
  return alert.signal.evidence.find((entry) => entry.field === field)?.[key];
}

function formatRatio(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) {
    return `${numeric.toFixed(2)}x`;
  }

  return String(value);
}

function formatPriceValue(value: string | number): string {
  const formatted = formatAlertPrice(String(value));
  return formatted === null ? String(value) : formatted;
}

function formatPlainNumber(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) {
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
  }

  return String(value);
}

function formatIsoClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(11, 19);
}
