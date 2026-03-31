import type { AppConfig } from '../config/schema.js';
import type { AlertTier } from '../types/signal.js';

export function clampSuspicionScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

export function deriveAlertTier(score: number, config: Pick<AppConfig, 'alerts'>): AlertTier {
  const clampedScore = clampSuspicionScore(score);
  if (clampedScore >= config.alerts.criticalMinScore) {
    return 'CRITICAL';
  }
  if (clampedScore >= config.alerts.highMinScore) {
    return 'HIGH';
  }
  if (clampedScore >= config.alerts.mediumMinScore) {
    return 'MEDIUM';
  }
  if (clampedScore >= config.alerts.lowMinScore) {
    return 'LOW';
  }
  return 'CLEAN';
}
