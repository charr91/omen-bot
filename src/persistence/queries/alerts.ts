import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { SCORING_VERSION } from '../../config/constants.js';
import { canonicalizeEvmAddress } from '../../evm/address.js';
import type {
  AlertChannelDispatchStatus,
  AlertDeliveryChannelName,
  AlertDispatchResult,
} from '../../alerts/channel.js';
import type { PromotedAlert, StoredAlert } from '../../types/alert.js';
import type { SignalAvailability, TriggeredSignal } from '../../types/signal.js';

interface AlertRow {
  id: string;
  wallet_address: string;
  market_id: string;
  fill_id: string;
  signal_id: string;
  signal_availability: SignalAvailability;
  signal_score: number;
  signal_confidence: number;
  signal_evidence: TriggeredSignal['evidence'];
  signal_triggered_at: Date;
  market_question: string;
  wallet_live_score: number;
  wallet_live_tier: StoredAlert['walletLiveTier'];
  delivery_tier: StoredAlert['deliveryTier'];
  dry_run: boolean;
  dispatch_eligible: boolean;
  promoted_at: Date;
  created_at: Date;
}

interface PendingAlertRow extends AlertRow {
  delivered_channels: AlertDeliveryChannelName[] | null;
}

export interface PendingStoredAlert extends StoredAlert {
  deliveredChannels: AlertDeliveryChannelName[];
}

export interface AlertStore {
  upsertPromotedAlert(alert: PromotedAlert, dispatchEligible: boolean): Promise<StoredAlert>;
  listPendingDispatchAlerts(limit: number): Promise<PendingStoredAlert[]>;
  recordDispatchResult(alertId: string, result: AlertDispatchResult, attemptedAt?: Date): Promise<void>;
  countRecentPromotedAlerts(since: Date): Promise<number>;
}

export function createAlertStore(pool: Pick<Pool, 'query'>): AlertStore {
  return {
    async upsertPromotedAlert(alert: PromotedAlert, dispatchEligible: boolean): Promise<StoredAlert> {
      const walletAddress = canonicalizeEvmAddress(alert.walletAddress);
      const result = await pool.query<AlertRow>(
        `
          insert into alerts (
            id,
            wallet_address,
            market_id,
            fill_id,
            signal_id,
            signal_availability,
            signal_score,
            signal_confidence,
            signal_evidence,
            signal_triggered_at,
            scoring_version,
            market_question,
            wallet_live_score,
            wallet_live_tier,
            delivery_tier,
            dry_run,
            dispatch_eligible,
            promoted_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
          )
          on conflict (fill_id, signal_id) do update
          set
            wallet_address = excluded.wallet_address,
            market_id = excluded.market_id,
            signal_availability = excluded.signal_availability,
            signal_score = excluded.signal_score,
            signal_confidence = excluded.signal_confidence,
            signal_evidence = excluded.signal_evidence,
            signal_triggered_at = excluded.signal_triggered_at,
            scoring_version = excluded.scoring_version,
            market_question = excluded.market_question,
            wallet_live_score = excluded.wallet_live_score,
            wallet_live_tier = excluded.wallet_live_tier,
            delivery_tier = excluded.delivery_tier,
            dry_run = excluded.dry_run,
            dispatch_eligible = excluded.dispatch_eligible,
            promoted_at = excluded.promoted_at
          returning *
        `,
        [
          alert.promotedAlertId ?? randomUUID(),
          walletAddress,
          alert.marketId,
          alert.fillId,
          alert.signal.signalId,
          alert.signal.availability,
          alert.signal.score,
          alert.signal.confidence,
          JSON.stringify(alert.signal.evidence),
          alert.signal.triggeredAt,
          SCORING_VERSION,
          alert.marketQuestion,
          alert.walletLiveScore,
          alert.walletLiveTier,
          alert.deliveryTier,
          alert.dryRun,
          dispatchEligible,
          alert.promotedAt,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Failed to upsert promoted alert for fill ${alert.fillId}`);
      }

      return mapAlertRow(row);
    },

    async listPendingDispatchAlerts(limit: number): Promise<PendingStoredAlert[]> {
      const result = await pool.query<PendingAlertRow>(
        `
          select
            alerts.*,
            coalesce(
              array_agg(distinct alert_deliveries.channel)
                filter (where alert_deliveries.status in ('sent', 'suppressed-duplicate')),
              '{}'::text[]
            ) as delivered_channels
          from alerts
          left join alert_deliveries on alert_deliveries.alert_id = alerts.id
          where alerts.dispatch_eligible = true
          group by alerts.id
          order by alerts.promoted_at asc
          limit $1
        `,
        [limit],
      );

      return result.rows.map((row) => ({
        ...mapAlertRow(row),
        deliveredChannels: row.delivered_channels ?? [],
      }));
    },

    async recordDispatchResult(alertId: string, result: AlertDispatchResult, attemptedAt = new Date()): Promise<void> {
      for (const channelResult of result.channelResults) {
        await pool.query(
          `
            insert into alert_deliveries (
              id,
              alert_id,
              channel,
              status,
              error_message,
              attempts,
              first_attempted_at,
              last_attempted_at,
              delivered_at
            )
            values ($1, $2, $3, $4, $5, 1, $6, $6, $7)
            on conflict (alert_id, channel) do update
            set
              status = excluded.status,
              error_message = excluded.error_message,
              attempts = alert_deliveries.attempts + 1,
              last_attempted_at = excluded.last_attempted_at,
              delivered_at = case
                when excluded.status in ('sent', 'suppressed-duplicate')
                  then coalesce(alert_deliveries.delivered_at, excluded.delivered_at)
                else alert_deliveries.delivered_at
              end,
              updated_at = now()
          `,
          [
            randomUUID(),
            alertId,
            channelResult.channel,
            channelResult.status,
            channelResult.error,
            attemptedAt,
            terminalDeliveryTime(channelResult.status, attemptedAt),
          ],
        );
      }
    },

    async countRecentPromotedAlerts(since: Date): Promise<number> {
      const result = await pool.query<{ count: string }>(
        `
          select count(*)::text as count
          from alerts
          where promoted_at >= $1
        `,
        [since],
      );

      return Number(result.rows[0]?.count ?? '0');
    },
  };
}

function mapAlertRow(row: AlertRow): StoredAlert {
  return {
    id: row.id,
    fillId: row.fill_id,
    walletAddress: canonicalizeEvmAddress(row.wallet_address),
    marketId: row.market_id,
    marketQuestion: row.market_question,
    walletLiveScore: row.wallet_live_score,
    walletLiveTier: row.wallet_live_tier,
    signal: {
      signalId: row.signal_id as TriggeredSignal['signalId'],
      availability: row.signal_availability,
      score: row.signal_score,
      confidence: row.signal_confidence,
      evidence: row.signal_evidence,
      triggeredAt: row.signal_triggered_at,
    },
    promotedAlertId: row.id,
    promotedAt: row.promoted_at.toISOString(),
    deliveryTier: row.delivery_tier,
    dryRun: row.dry_run,
    dispatchEligible: row.dispatch_eligible,
    createdAt: row.created_at.toISOString(),
  };
}

function terminalDeliveryTime(
  status: AlertChannelDispatchStatus,
  attemptedAt: Date,
): Date | null {
  return status === 'sent' || status === 'suppressed-duplicate' ? attemptedAt : null;
}
