import type { PromotedAlert, PromotedAlertTier } from '../types/alert.js';

export type AlertDeliveryChannelName = 'telegram' | 'discord';
export type AlertChannelDispatchStatus = 'sent' | 'suppressed-dry-run' | 'suppressed-duplicate' | 'failed';
export type AlertDispatchStatus =
  | 'sent'
  | 'sent-partial'
  | 'suppressed-dry-run'
  | 'suppressed-duplicate'
  | 'disabled'
  | 'failed';

export interface AlertChannelDispatchResult {
  channel: AlertDeliveryChannelName;
  status: AlertChannelDispatchStatus;
  error: string | null;
}

export interface AlertDispatchResult {
  status: AlertDispatchStatus;
  channels: AlertDeliveryChannelName[];
  failedChannels: AlertDeliveryChannelName[];
  channelResults: AlertChannelDispatchResult[];
}

export interface AlertDeliveryChannel {
  readonly name: AlertDeliveryChannelName;
  isEnabledForTier(tier: PromotedAlertTier): boolean;
  dispatch(alert: PromotedAlert): Promise<void>;
}
