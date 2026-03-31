import type { PromotedAlert, PromotedAlertTier } from '../types/alert.js';

export type AlertDeliveryChannelName = 'telegram' | 'discord';
export type AlertDispatchStatus = 'sent' | 'suppressed-dry-run' | 'suppressed-duplicate' | 'disabled';

export interface AlertDispatchResult {
  status: AlertDispatchStatus;
  channels: AlertDeliveryChannelName[];
}

export interface AlertDeliveryChannel {
  readonly name: AlertDeliveryChannelName;
  isEnabledForTier(tier: PromotedAlertTier): boolean;
  dispatch(alert: PromotedAlert): Promise<void>;
}
