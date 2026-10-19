import type { TriggeredSignal } from '../types/signal.js';
import { isShadowSignal } from './fresh-wallet-longshot.js';

/** Score-only: adds to the wallet's deliverable score, but its own alert is stored + graded, never delivered. */
export function isScoreOnlySignal(signal: Pick<TriggeredSignal, 'scoreOnly'>): boolean {
  return signal.scoreOnly === true;
}

/** Whether a signal's own alert may reach Telegram/Discord or the feed (neither shadow nor score-only). */
export function isSignalDeliverable(signal: Pick<TriggeredSignal, 'shadow' | 'scoreOnly'>): boolean {
  return !isShadowSignal(signal) && !isScoreOnlySignal(signal);
}
