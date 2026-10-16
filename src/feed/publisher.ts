import type { Pool } from 'pg';
import { FeedClient, type AlertEnvelopeInput, type Severity } from '@charr91/smart-money-feed';
import type { StoredAlert } from '../types/alert.js';

/**
 * omen -> shared feed (M3). omen keeps its own DB; it only writes envelopes + outcomes into the feed schema.
 * alertKey = omen fill id (Polymarket) or `kalshi:<signal id>`, the same key trade_outcomes uses, so a live alert
 * and its M1 outcome row land on one feed row.
 */
export function severityForTier(tier: string | null): Severity {
  switch (tier) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'info';
  }
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function liveAlertEnvelope(alert: StoredAlert): AlertEnvelopeInput {
  return {
    schemaVersion: 1,
    sourceApp: 'omen',
    alertKey: alert.fillId,
    kind: 'signal',
    venue: 'polymarket',
    subject: { id: alert.marketId, label: alert.marketQuestion ?? '', url: alert.marketUrl ?? null },
    direction: alert.fillSide === 'SELL' ? 'short' : 'long',
    priceAtAlert: finiteOrNull(alert.fillPrice),
    sizeUsd: finiteOrNull(alert.fillSizeUsd),
    severity: severityForTier(alert.deliveryTier),
    signals: [alert.signal.signalId],
    appTier: alert.deliveryTier,
    details: {
      outcome: `${alert.fillSide} ${alert.fillOutcome}`,
      wallet: alert.walletAddress,
      'wallet score': `${Math.round(alert.walletLiveScore)}/100 (${alert.walletLiveTier})`,
    },
    alertAt: alert.fillTimestamp ? new Date(alert.fillTimestamp) : new Date(alert.promotedAt),
    deliver: true,
    scoreBy: 'app',
  };
}

interface OutcomeSyncRow {
  fill_id: string;
  feed_synced_at?: Date | null;
  kind: 'signal' | 'baseline';
  ref_fill_id: string | null;
  signal_ids: string[];
  delivery_tier: string | null;
  venue: string;
  market_id: string;
  token_id: string;
  side: string;
  size_usd: string;
  alert_at: Date;
  price_at_alert: string;
  price_1h: string | null;
  price_24h: string | null;
  resolution_price: string | null;
}

export const FEED_SYNC_SCHEMA_SQL = 'alter table trade_outcomes add column if not exists feed_synced_at timestamptz;';

/** Mirrors M1 trade_outcomes (signals + baselines, all venues) into the feed: envelope + outcome, incrementally. */
export interface OutcomeSyncOptions {
  /** Default true: Kalshi rows are stored/graded only (deliver=false, severity info). */
  muteKalshi?: boolean;
  now?: Date;
}

/** Only a fresh (< 1h old, first sync) Kalshi signal may be delivered, and only when Kalshi is unmuted. */
const KALSHI_DELIVER_MAX_AGE_MS = 3_600_000;

export async function syncOutcomesToFeed(
  omenDb: Pick<Pool, 'query'>,
  feed: FeedClient,
  limit = 500,
  options: OutcomeSyncOptions = {},
): Promise<number> {
  const muteKalshi = options.muteKalshi ?? true;
  const now = options.now ?? new Date();
  const result = await omenDb.query<OutcomeSyncRow>(
    `
      select o.fill_id, o.kind, o.feed_synced_at, o.ref_fill_id, coalesce(r.signal_ids, o.signal_ids) as signal_ids,
        coalesce(o.delivery_tier, r.delivery_tier) as delivery_tier, o.venue, o.market_id, o.token_id, o.side,
        o.size_usd::text, o.alert_at, o.price_at_alert::text, o.price_1h::text, o.price_24h::text, o.resolution_price::text
      from trade_outcomes o
      left join trade_outcomes r on r.fill_id = o.ref_fill_id
      where o.feed_synced_at is null
         or greatest(o.price_1h_checked_at, o.price_24h_checked_at, o.resolved_at, o.resolution_checked_at) > o.feed_synced_at
      order by o.alert_at
      limit $1
    `,
    [limit],
  );
  let synced = 0;
  for (const row of result.rows) {
    if (row.signal_ids.length === 0) continue;
    const isKalshi = row.venue === 'kalshi';
    const deliverKalshi =
      isKalshi &&
      !muteKalshi &&
      row.kind === 'signal' &&
      !row.feed_synced_at &&
      now.getTime() - new Date(row.alert_at).getTime() <= KALSHI_DELIVER_MAX_AGE_MS;
    await feed.publish({
      schemaVersion: 1,
      sourceApp: 'omen',
      alertKey: row.fill_id,
      kind: row.kind,
      refAlertKey: row.ref_fill_id,
      venue: isKalshi ? 'kalshi' : 'polymarket',
      subject: { id: row.market_id, instrumentId: isKalshi ? null : row.token_id },
      direction: row.side === 'SELL' ? 'short' : 'long',
      priceAtAlert: Number(row.price_at_alert),
      sizeUsd: finiteOrNull(row.size_usd),
      severity: row.kind === 'baseline' ? 'info' : deliverKalshi ? 'medium' : severityForTier(row.delivery_tier),
      signals: row.signal_ids,
      appTier: row.delivery_tier,
      alertAt: row.alert_at,
      deliver: deliverKalshi,
      scoreBy: 'app',
    });
    await feed.recordOutcome('omen', row.fill_id, {
      price1h: finiteOrNull(row.price_1h),
      price24h: finiteOrNull(row.price_24h),
      resolutionPrice: finiteOrNull(row.resolution_price),
    });
    await omenDb.query('update trade_outcomes set feed_synced_at = now() where fill_id = $1', [row.fill_id]);
    synced += 1;
  }
  return synced;
}
