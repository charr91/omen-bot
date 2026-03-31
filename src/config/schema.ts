import { z } from 'zod';

const booleanStringSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const positiveIntegerStringSchema = z
  .string()
  .min(1)
  .transform((value) => Number(value))
  .pipe(z.number().int().positive());

const webhookUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'must be an HTTPS URL');

export const fileConfigSchema = z
  .object({
    ingestion: z
      .object({
        poll_interval_ms: z.number().int().positive().optional(),
        max_pages_per_poll: z.number().int().positive().optional(),
      })
      .optional(),
    detection: z
      .object({
        fresh_wallet: z
          .object({
            critical_age_hours: z.number().positive().optional(),
            elevated_age_hours: z.number().positive().optional(),
            max_txns: z.number().int().nonnegative().optional(),
          })
          .optional(),
        market: z
          .object({
            niche_max_volume: z.number().positive().optional(),
            large_position_min_usd: z.number().positive().optional(),
            large_position_volume_pct: z.number().positive().optional(),
          })
          .optional(),
      })
      .optional(),
    alerts: z
      .object({
        critical_min_score: z.number().min(0).max(100).optional(),
        high_min_score: z.number().min(0).max(100).optional(),
        medium_min_score: z.number().min(0).max(100).optional(),
        low_min_score: z.number().min(0).max(100).optional(),
        dedup_cooldown_ms: z.number().int().positive().optional(),
      })
      .optional(),
    operational: z
      .object({
        dry_run: z.boolean().optional(),
      })
      .optional(),
    backpressure: z
      .object({
        hot_worker_queue_depth: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .transform((value) => ({
    ingestion: {
      poll_interval_ms: value.ingestion?.poll_interval_ms ?? 15_000,
      max_pages_per_poll: value.ingestion?.max_pages_per_poll ?? 20,
    },
    detection: {
      fresh_wallet: {
        critical_age_hours: value.detection?.fresh_wallet?.critical_age_hours ?? 24,
        elevated_age_hours: value.detection?.fresh_wallet?.elevated_age_hours ?? 72,
        max_txns: value.detection?.fresh_wallet?.max_txns ?? 10,
      },
      market: {
        niche_max_volume: value.detection?.market?.niche_max_volume ?? 100_000,
        large_position_min_usd: value.detection?.market?.large_position_min_usd ?? 1_000,
        large_position_volume_pct: value.detection?.market?.large_position_volume_pct ?? 0.02,
      },
    },
    alerts: {
      critical_min_score: value.alerts?.critical_min_score ?? 80,
      high_min_score: value.alerts?.high_min_score ?? 60,
      medium_min_score: value.alerts?.medium_min_score ?? 40,
      low_min_score: value.alerts?.low_min_score ?? 20,
      dedup_cooldown_ms: value.alerts?.dedup_cooldown_ms ?? 86_400_000,
    },
    operational: {
      dry_run: value.operational?.dry_run ?? false,
    },
    backpressure: {
      hot_worker_queue_depth: value.backpressure?.hot_worker_queue_depth ?? 100,
    },
  }));

export const envConfigSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  ALCHEMY_API_KEY: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID_CRITICAL: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID_MEDIUM: z.string().min(1).optional(),
  DISCORD_WEBHOOK_CRITICAL: webhookUrlSchema.optional(),
  DISCORD_WEBHOOK_MEDIUM: webhookUrlSchema.optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  LOG_PRETTY: booleanStringSchema,
  OMEN_INGESTION_POLL_INTERVAL_MS: positiveIntegerStringSchema.optional(),
  OMEN_INGESTION_MAX_PAGES_PER_POLL: positiveIntegerStringSchema.optional(),
  OMEN_OPERATIONAL_DRY_RUN: booleanStringSchema.optional(),
  OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH: positiveIntegerStringSchema.optional(),
});

export type FileConfig = z.infer<typeof fileConfigSchema>;
export type EnvConfig = z.infer<typeof envConfigSchema>;

export interface AppConfig {
  configPath: string;
  databaseUrl: string;
  redisUrl: string;
  alchemyApiKey: string | null;
  telegram: {
    botToken: string | null;
    criticalChatId: string | null;
    mediumChatId: string | null;
  };
  discord: {
    criticalWebhookUrl: string | null;
    mediumWebhookUrl: string | null;
  };
  logLevel: EnvConfig['LOG_LEVEL'];
  logPretty: boolean;
  ingestion: {
    pollIntervalMs: number;
    maxPagesPerPoll: number;
  };
  detection: {
    freshWallet: {
      criticalAgeHours: number;
      elevatedAgeHours: number;
      maxTransactions: number;
    };
    market: {
      nicheMaxVolume: number;
      largePositionMinUsd: number;
      largePositionVolumePct: number;
    };
  };
  alerts: {
    criticalMinScore: number;
    highMinScore: number;
    mediumMinScore: number;
    lowMinScore: number;
    dedupCooldownMs: number;
  };
  operational: {
    dryRun: boolean;
  };
  backpressure: {
    hotWorkerQueueDepth: number;
  };
}
