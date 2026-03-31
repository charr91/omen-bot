import type { FillRecord } from './fill.js';
import type { AlertTier, TriggeredSignal } from './signal.js';

export type EnqueueFillResult = 'accepted' | 'duplicate' | 'full';

export type MainToHotWorkerMessage =
  | {
      type: 'ANALYZE_FILL';
      fill: FillRecord;
    }
  | {
      type: 'STOP';
    };

export type HotWorkerToMainMessage =
  | {
      type: 'HEARTBEAT';
      at: string;
      queueDepth: number;
      processing: boolean;
      lastProcessedAt: string | null;
    }
  | {
      type: 'ENQUEUE_RESULT';
      fillId: string;
      result: EnqueueFillResult;
    }
  | {
      type: 'FILL_RESULT';
      fillId: string;
      status: 'processed' | 'failed';
      error: string | null;
    }
  | {
      type: 'ALERT_PREVIEW';
      fillId: string;
      walletAddress: string;
      marketId: string;
      marketQuestion: string;
      walletLiveScore: number;
      walletLiveTier: AlertTier;
      signal: TriggeredSignal;
      dryRun: boolean;
    }
  | {
      type: 'ERROR';
      error: string;
      fillId: string | null;
    };
