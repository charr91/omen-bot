import type { FillStore } from '../persistence/queries/fills.js';
import type { FillRecord, FillSide } from '../types/fill.js';
import type { AlertLinkedTradeContext, PromotedAlert, StoredAlert } from '../types/alert.js';

export const ALERT_LINKED_TRADE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

type AlertWithTradeFields = Pick<
  PromotedAlert,
  'fillId' | 'walletAddress' | 'marketId' | 'fillSide' | 'promotedAt'
> & {
  fillTimestamp?: Date | string | null;
};

export async function enrichAlertWithLinkedTradeContext<T extends PromotedAlert | StoredAlert>(
  alert: T,
  fillStore: FillStore,
): Promise<T & { linkedTradeContext: AlertLinkedTradeContext | null }> {
  const linkedTradeContext = await resolveLinkedTradeContext(alert, fillStore);
  return {
    ...alert,
    linkedTradeContext,
  };
}

async function resolveLinkedTradeContext(
  alert: AlertWithTradeFields,
  fillStore: FillStore,
): Promise<AlertLinkedTradeContext | null> {
  const boundaryTime = resolveAlertBoundaryTime(alert);
  const recentMarketFills = await fillStore.listMarketFillsByWallets(
    alert.marketId,
    [alert.walletAddress],
    new Date(boundaryTime.getTime() - ALERT_LINKED_TRADE_LOOKBACK_MS),
    {
      fillTimestamp: boundaryTime,
      fillId: alert.fillId,
    },
    {
      side: getOppositeSide(alert.fillSide),
    },
  );

  const oppositeSide = getOppositeSide(alert.fillSide);
  const oppositeSideFills = recentMarketFills.filter((candidateFill) => candidateFill.id !== alert.fillId);

  if (oppositeSideFills.length === 0) {
    return null;
  }

  const latest = oppositeSideFills.at(-1);
  if (!latest) {
    return null;
  }

  return {
    oppositeSide,
    recentCount: oppositeSideFills.length,
    latest: mapLinkedTradeSummary(latest),
  };
}

function resolveAlertBoundaryTime(alert: AlertWithTradeFields): Date {
  const candidate =
    alert.fillTimestamp instanceof Date
      ? alert.fillTimestamp
      : alert.fillTimestamp
        ? new Date(alert.fillTimestamp)
        : new Date(alert.promotedAt);

  if (!Number.isNaN(candidate.getTime())) {
    return candidate;
  }

  return new Date(alert.promotedAt);
}

function getOppositeSide(side: FillSide): FillSide {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

function mapLinkedTradeSummary(fill: FillRecord): AlertLinkedTradeContext['latest'] {
  return {
    fillId: fill.id,
    fillSide: fill.side,
    fillOutcome: fill.outcome,
    fillPrice: fill.price,
    fillSizeUsd: fill.sizeUsd,
    fillTimestamp: fill.timestamp.toISOString(),
  };
}
