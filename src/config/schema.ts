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
        min_profile_fill_usd: z.number().nonnegative().optional(),
        profile_cache_ttl_ms: z.number().int().positive().optional(),
        persisted_profile_ttl_ms: z.number().int().positive().optional(),
        daily_cu_budget: z.number().int().nonnegative().optional(),
        hot_budget_share: z.number().min(0).max(1).optional(),
      })
      .optional(),
    cold_path: z
      .object({
        concurrency: z.number().int().positive().optional(),
        rebuild_failure_cooldown_ms: z.number().int().positive().optional(),
        shutdown_timeout_ms: z.number().int().positive().optional(),
        rebuild_min_fill_usd: z.number().nonnegative().optional(),
        rebuild_if_signaled: z.boolean().optional(),
      })
      .optional(),
    outcomes: z
      .object({
        enabled: z.boolean().optional(),
        interval_ms: z.number().int().positive().optional(),
        baseline_per_signal: z.number().int().nonnegative().optional(),
        baseline_window_hours: z.number().positive().optional(),
      })
      .optional(),
    feed: z
      .object({
        enabled: z.boolean().optional(),
        publish_live_alerts: z.boolean().optional(),
        sync_outcomes: z.boolean().optional(),
      })
      .optional(),
    kalshi: z
      .object({
        enabled: z.boolean().optional(),
        trade_poll_ms: z.number().int().positive().optional(),
        market_cycle_ms: z.number().int().positive().optional(),
        store_min_notional_usd: z.number().nonnegative().optional(),
        large_print_usd: z.number().positive().optional(),
        volume_spike_min_hour_usd: z.number().nonnegative().optional(),
        book_move_min_cents: z.number().positive().optional(),
        book_move_window_ms: z.number().int().positive().optional(),
        depth_pull_ratio: z.number().positive().max(1).optional(),
        divergence_min_gap: z.number().positive().optional(),
        book_watchlist_size: z.number().int().nonnegative().optional(),
      })
      .optional(),
    market_maker: z
      .object({
        filter_enabled: z.boolean().optional(),
        min_score: z.number().int().min(0).max(100).optional(),
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
      min_profile_fill_usd: value.alchemy?.min_profile_fill_usd ?? 500,
      persisted_profile_ttl_ms: value.alchemy?.persisted_profile_ttl_ms ?? 7 * 24 * 60 * 60_000,
      profile_cache_ttl_ms: value.alchemy?.profile_cache_ttl_ms ?? 24 * 60 * 60_000,
      daily_cu_budget: value.alchemy?.daily_cu_budget ?? 1_000_000,
      hot_budget_share: value.alchemy?.hot_budget_share ?? 0.4,
    },
    cold_path: {
      concurrency: value.cold_path?.concurrency ?? 1,
      rebuild_failure_cooldown_ms: value.cold_path?.rebuild_failure_cooldown_ms ?? 15 * 60_000,
      shutdown_timeout_ms: value.cold_path?.shutdown_timeout_ms ?? 30_000,
      rebuild_min_fill_usd: value.cold_path?.rebuild_min_fill_usd ?? 500,
      rebuild_if_signaled: value.cold_path?.rebuild_if_signaled ?? true,
    },
    outcomes: {
      enabled: value.outcomes?.enabled ?? true,
      interval_ms: value.outcomes?.interval_ms ?? 5 * 60_000,
      baseline_per_signal: value.outcomes?.baseline_per_signal ?? 3,
      baseline_window_hours: value.outcomes?.baseline_window_hours ?? 6,
    },
    feed: {
      enabled: value.feed?.enabled ?? false,
      publish_live_alerts: value.feed?.publish_live_alerts ?? true,
      sync_outcomes: value.feed?.sync_outcomes ?? true,
    },
    kalshi: {
      enabled: value.kalshi?.enabled ?? false,
      trade_poll_ms: value.kalshi?.trade_poll_ms ?? 15_000,
      market_cycle_ms: value.kalshi?.market_cycle_ms ?? 60_000,
      store_min_notional_usd: value.kalshi?.store_min_notional_usd ?? 250,
      large_print_usd: value.kalshi?.large_print_usd ?? 10_000,
      volume_spike_min_hour_usd: value.kalshi?.volume_spike_min_hour_usd ?? 5_000,
      book_move_min_cents: value.kalshi?.book_move_min_cents ?? 8,
      book_move_window_ms: value.kalshi?.book_move_window_ms ?? 15 * 60_000,
      depth_pull_ratio: value.kalshi?.depth_pull_ratio ?? 0.7,
      divergence_min_gap: value.kalshi?.divergence_min_gap ?? 0.06,
      book_watchlist_size: value.kalshi?.book_watchlist_size ?? 40,
    },
    market_maker: {
      filter_enabled: value.market_maker?.filter_enabled ?? true,
      min_score: value.market_maker?.min_score ?? 70,
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
  OMEN_ALCHEMY_MIN_PROFILE_FILL_USD: positiveIntegerStringSchema.optional(),
  OMEN_ALCHEMY_PROFILE_CACHE_TTL_MS: positiveIntegerStringSchema.optional(),
  OMEN_ALCHEMY_DAILY_CU_BUDGET: positiveIntegerStringSchema.optional(),
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
    /** Fills below this USD size skip chain profiling and funding-graph rebuilds (no live signal can fire). */
    minProfileFillUsd: number;
    profileCacheTtlMs: number;
    /** Postgres-persisted profiles of settled (never-fresh-again) wallets are reused for this long, across restarts. */
    persistedProfileTtlMs: number;
    /** UTC-day CU budget (0 = unlimited). Hot gets hotBudgetShare, cold the rest. */
    dailyCuBudget: number;
    hotBudgetShare: number;
  };
  coldPath: {
    concurrency: number;
    rebuildFailureCooldownMs: number;
    shutdownTimeoutMs: number;
    /** Funding graphs are rebuilt only for fills >= this size, or for wallets with a signal (rebuildIfSignaled). */
    rebuildMinFillUsd: number;
    rebuildIfSignaled: boolean;
  };
  /** Alert grading: price at +1h/+24h, resolution, and same-market baseline fills (M1). */
  outcomes: {
    enabled: boolean;
    intervalMs: number;
    baselinePerSignal: number;
    baselineWindowHours: number;
  };
  /** M3: shared alert feed (@charr91/smart-money-feed) in its own database (FEED_DATABASE_URL). */
  feed: {
    enabled: boolean;
    databaseUrl: string | null;
    /** Publish promoted alerts with deliver=true; the feed process owns Telegram (dry run by default). */
    publishLiveAlerts: boolean;
    /** Mirror M1 trade_outcomes (signals + baselines) into feed.outcomes after each tracker run. */
    syncOutcomes: boolean;
  };
  /** M2: Kalshi public REST ingest + market-level signals (stored and graded only, never dispatched). */
  kalshi: {
    enabled: boolean;
    tradePollMs: number;
    marketCycleMs: number;
    storeMinNotionalUsd: number;
    largePrintUsd: number;
    volumeSpikeMinHourUsd: number;
    bookMoveMinCents: number;
    bookMoveWindowMs: number;
    depthPullRatio: number;
    divergenceMinGap: number;
    bookWatchlistSize: number;
  };
  /** insider-poly-bot market-maker heuristic: suppress signals from likely MMs and keep them out of baselines. */
  marketMaker: {
    filterEnabled: boolean;
    minScore: number;
  };
}
