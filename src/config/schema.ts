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
        niche_market_entry: z
          .object({
            max_market_volume_usd: z.number().positive().optional(),
            min_fill_usd: z.number().positive().optional(),
          })
          .optional(),
        conviction_size_mismatch: z
          .object({
            max_wallet_total_volume_usd: z.number().positive().optional(),
            min_fill_to_wallet_volume_ratio: z.number().positive().optional(),
            longshot_max_price: z.number().positive().optional(),
            min_fill_usd: z.number().positive().optional(),
          })
          .optional(),
        lump_entry: z
          .object({
            min_fill_usd: z.number().positive().optional(),
            min_lump_ratio: z.number().positive().optional(),
          })
          .optional(),
        excluded_categories: z.record(z.string(), z.array(z.string().min(1))).optional(),
        cluster: z
          .object({
            min_size: z.number().int().positive().optional(),
            min_fill_usd: z.number().positive().optional(),
            elevated_fill_usd: z.number().positive().optional(),
            funding_max_depth: z.number().int().positive().optional(),
            fanout_limit: z.number().int().positive().optional(),
            max_rpc_calls: z.number().int().positive().optional(),
            same_market_same_side_window_ms: z.number().int().positive().optional(),
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
        dedup_score_increase: z.number().nonnegative().optional(),
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
    alchemy: z
      .object({
        hot_cu_per_second: z.number().positive().optional(),
        cold_cu_per_second: z.number().positive().optional(),
        max_wait_ms: z.number().int().positive().optional(),
        max_queue: z.number().int().positive().optional(),
        max_429_retries: z.number().int().nonnegative().optional(),
      })
      .optional(),
    cold_path: z
      .object({
        concurrency: z.number().int().positive().optional(),
        rebuild_failure_cooldown_ms: z.number().int().positive().optional(),
        shutdown_timeout_ms: z.number().int().positive().optional(),
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
      niche_market_entry: {
        max_market_volume_usd: value.detection?.niche_market_entry?.max_market_volume_usd ?? 100_000,
        min_fill_usd: value.detection?.niche_market_entry?.min_fill_usd ?? 1_000,
      },
      conviction_size_mismatch: {
        max_wallet_total_volume_usd:
          value.detection?.conviction_size_mismatch?.max_wallet_total_volume_usd ?? 5_000,
        min_fill_to_wallet_volume_ratio:
          value.detection?.conviction_size_mismatch?.min_fill_to_wallet_volume_ratio ?? 0.5,
        longshot_max_price: value.detection?.conviction_size_mismatch?.longshot_max_price ?? 0.3,
        min_fill_usd: value.detection?.conviction_size_mismatch?.min_fill_usd ?? 250,
      },
      lump_entry: {
        min_fill_usd: value.detection?.lump_entry?.min_fill_usd ?? 500,
        min_lump_ratio: value.detection?.lump_entry?.min_lump_ratio ?? 0.8,
      },
      excluded_categories: value.detection?.excluded_categories ?? {},
      cluster: {
        min_size: value.detection?.cluster?.min_size ?? 3,
        min_fill_usd: value.detection?.cluster?.min_fill_usd ?? 200,
        elevatedFillUsd: value.detection?.cluster?.elevated_fill_usd ?? 500,
        funding_max_depth: value.detection?.cluster?.funding_max_depth ?? 4,
        fanout_limit: value.detection?.cluster?.fanout_limit ?? 5,
        max_rpc_calls: value.detection?.cluster?.max_rpc_calls ?? 200,
        same_market_same_side_window_ms:
          value.detection?.cluster?.same_market_same_side_window_ms ?? 60 * 60_000,
      },
    },
    alerts: {
      critical_min_score: value.alerts?.critical_min_score ?? 80,
      high_min_score: value.alerts?.high_min_score ?? 60,
      medium_min_score: value.alerts?.medium_min_score ?? 40,
      low_min_score: value.alerts?.low_min_score ?? 20,
      dedup_cooldown_ms: value.alerts?.dedup_cooldown_ms ?? 86_400_000,
      dedup_score_increase: value.alerts?.dedup_score_increase ?? 10,
    },
    operational: {
      dry_run: value.operational?.dry_run ?? false,
    },
    backpressure: {
      hot_worker_queue_depth: value.backpressure?.hot_worker_queue_depth ?? 100,
    },
    alchemy: {
      hot_cu_per_second: value.alchemy?.hot_cu_per_second ?? 200,
      cold_cu_per_second: value.alchemy?.cold_cu_per_second ?? 80,
      max_wait_ms: value.alchemy?.max_wait_ms ?? 20_000,
      max_queue: value.alchemy?.max_queue ?? 500,
      max_429_retries: value.alchemy?.max_429_retries ?? 3,
    },
    cold_path: {
      concurrency: value.cold_path?.concurrency ?? 1,
      rebuild_failure_cooldown_ms: value.cold_path?.rebuild_failure_cooldown_ms ?? 15 * 60_000,
      shutdown_timeout_ms: value.cold_path?.shutdown_timeout_ms ?? 30_000,
    },
  }))
  .refine(
    (cfg) => cfg.detection.cluster.elevatedFillUsd > cfg.detection.cluster.min_fill_usd,
    {
      message: 'elevated_fill_usd must be greater than min_fill_usd',
      path: ['detection', 'cluster', 'elevated_fill_usd'],
    },
  );

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
  OMEN_COLD_PATH_CONCURRENCY: positiveIntegerStringSchema.optional(),
  OMEN_ALCHEMY_HOT_CU_PER_SECOND: positiveIntegerStringSchema.optional(),
  OMEN_ALCHEMY_COLD_CU_PER_SECOND: positiveIntegerStringSchema.optional(),
  OMEN_ALCHEMY_MAX_WAIT_MS: positiveIntegerStringSchema.optional(),
  OMEN_COLD_PATH_REBUILD_FAILURE_COOLDOWN_MS: positiveIntegerStringSchema.optional(),
  OMEN_COLD_PATH_SHUTDOWN_TIMEOUT_MS: positiveIntegerStringSchema.optional(),
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
    nicheMarketEntry: {
      maxMarketVolumeUsd: number;
      minFillUsd: number;
    };
    convictionSizeMismatch: {
      maxWalletTotalVolumeUsd: number;
      minFillToWalletVolumeRatio: number;
      longshotMaxPrice: number;
      minFillUsd: number;
    };
    lumpEntry: {
      minFillUsd: number;
      minLumpRatio: number;
    };
    excludedCategories: Record<string, string[]>;
    cluster: {
      minSize: number;
      minFillUsd: number;
      elevatedFillUsd: number;
      fundingMaxDepth: number;
      fanoutLimit: number;
      maxRpcCalls: number;
      sameMarketSameSideWindowMs: number;
    };
  };
  alerts: {
    criticalMinScore: number;
    highMinScore: number;
    mediumMinScore: number;
    lowMinScore: number;
    dedupCooldownMs: number;
    dedupScoreIncrease: number;
  };
  operational: {
    dryRun: boolean;
  };
  backpressure: {
    hotWorkerQueueDepth: number;
  };
  alchemy: {
    hotCuPerSecond: number;
    coldCuPerSecond: number;
    maxWaitMs: number;
    maxQueue: number;
    max429Retries: number;
  };
  coldPath: {
    concurrency: number;
    rebuildFailureCooldownMs: number;
    shutdownTimeoutMs: number;
  };
}
