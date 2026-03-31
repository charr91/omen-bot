import type { PromotedAlert, SignalPreview } from '../types/alert.js';

export function promoteSignalPreview(
  preview: SignalPreview,
  promotedAt = new Date(),
): PromotedAlert | null {
  if (preview.walletLiveTier === 'CLEAN') {
    return null;
  }

  return {
    ...preview,
    promotedAt: promotedAt.toISOString(),
    deliveryTier: preview.walletLiveTier,
  };
}
