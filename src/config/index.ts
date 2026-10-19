import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { envConfigSchema, fileConfigSchema, type AppConfig } from './schema.js';

const require = createRequire(import.meta.url);
const toml = require('toml') as {
  parse(input: string): unknown;
};

export const DEFAULT_CONFIG_PATH = 'omen.config.toml';

interface LoadAppConfigOptions {
  cwd?: string;
  configPath?: string;
}

export async function loadAppConfig(options: LoadAppConfigOptions = {}): Promise<AppConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_CONFIG_PATH);
  const fileConfig = fileConfigSchema.parse(await readTomlConfig(configPath));
  const envConfig = envConfigSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    ALCHEMY_API_KEY: readOptionalEnv(process.env.ALCHEMY_API_KEY),
    TELEGRAM_BOT_TOKEN: readOptionalEnv(process.env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_CHAT_ID_CRITICAL: readOptionalEnv(process.env.TELEGRAM_CHAT_ID_CRITICAL),
    TELEGRAM_CHAT_ID_MEDIUM: readOptionalEnv(process.env.TELEGRAM_CHAT_ID_MEDIUM),
    DISCORD_WEBHOOK_CRITICAL: readOptionalEnv(process.env.DISCORD_WEBHOOK_CRITICAL),
    DISCORD_WEBHOOK_MEDIUM: readOptionalEnv(process.env.DISCORD_WEBHOOK_MEDIUM),
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    LOG_PRETTY: process.env.LOG_PRETTY ?? 'true',
    OMEN_INGESTION_POLL_INTERVAL_MS: readOptionalEnv(process.env.OMEN_INGESTION_POLL_INTERVAL_MS),
    OMEN_INGESTION_MAX_PAGES_PER_POLL: readOptionalEnv(process.env.OMEN_INGESTION_MAX_PAGES_PER_POLL),
    OMEN_OPERATIONAL_DRY_RUN: readOptionalEnv(process.env.OMEN_OPERATIONAL_DRY_RUN),
    OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH: readOptionalEnv(process.env.OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH),
    OMEN_COLD_PATH_CONCURRENCY: readOptionalEnv(process.env.OMEN_COLD_PATH_CONCURRENCY),
    OMEN_ALCHEMY_HOT_CU_PER_SECOND: readOptionalEnv(process.env.OMEN_ALCHEMY_HOT_CU_PER_SECOND),
    OMEN_ALCHEMY_COLD_CU_PER_SECOND: readOptionalEnv(process.env.OMEN_ALCHEMY_COLD_CU_PER_SECOND),
    OMEN_ALCHEMY_MAX_WAIT_MS: readOptionalEnv(process.env.OMEN_ALCHEMY_MAX_WAIT_MS),
    OMEN_ALCHEMY_MIN_PROFILE_FILL_USD: readOptionalEnv(process.env.OMEN_ALCHEMY_MIN_PROFILE_FILL_USD),
    OMEN_ALCHEMY_PROFILE_CACHE_TTL_MS: readOptionalEnv(process.env.OMEN_ALCHEMY_PROFILE_CACHE_TTL_MS),
    OMEN_ALCHEMY_DAILY_CU_BUDGET: readOptionalEnv(process.env.OMEN_ALCHEMY_DAILY_CU_BUDGET),
    OMEN_COLD_PATH_REBUILD_FAILURE_COOLDOWN_MS: readOptionalEnv(
      process.env.OMEN_COLD_PATH_REBUILD_FAILURE_COOLDOWN_MS,
    ),
    OMEN_COLD_PATH_SHUTDOWN_TIMEOUT_MS: readOptionalEnv(process.env.OMEN_COLD_PATH_SHUTDOWN_TIMEOUT_MS),
  });

  return {
    configPath,
    databaseUrl: envConfig.DATABASE_URL,
    redisUrl: envConfig.REDIS_URL,
    alchemyApiKey: envConfig.ALCHEMY_API_KEY ?? null,
    telegram: {
      botToken: envConfig.TELEGRAM_BOT_TOKEN ?? null,
      criticalChatId: envConfig.TELEGRAM_CHAT_ID_CRITICAL ?? null,
      mediumChatId: envConfig.TELEGRAM_CHAT_ID_MEDIUM ?? null,
    },
    discord: {
      criticalWebhookUrl: envConfig.DISCORD_WEBHOOK_CRITICAL ?? null,
      mediumWebhookUrl: envConfig.DISCORD_WEBHOOK_MEDIUM ?? null,
    },
    logLevel: envConfig.LOG_LEVEL,
    logPretty: envConfig.LOG_PRETTY,
    ingestion: {
      pollIntervalMs: envConfig.OMEN_INGESTION_POLL_INTERVAL_MS ?? fileConfig.ingestion.poll_interval_ms,
      maxPagesPerPoll: envConfig.OMEN_INGESTION_MAX_PAGES_PER_POLL ?? fileConfig.ingestion.max_pages_per_poll,
    },
    detection: {
      freshWallet: {
        criticalAgeHours: fileConfig.detection.fresh_wallet.critical_age_hours,
        elevatedAgeHours: fileConfig.detection.fresh_wallet.elevated_age_hours,
        maxTransactions: fileConfig.detection.fresh_wallet.max_txns,
      },
      market: {
        nicheMaxVolume: fileConfig.detection.market.niche_max_volume,
        largePositionMinUsd: fileConfig.detection.market.large_position_min_usd,
        largePositionVolumePct: fileConfig.detection.market.large_position_volume_pct,
      },
      nicheMarketEntry: {
        maxMarketVolumeUsd: fileConfig.detection.niche_market_entry.max_market_volume_usd,
        minFillUsd: fileConfig.detection.niche_market_entry.min_fill_usd,
      },
      convictionSizeMismatch: {
        maxWalletTotalVolumeUsd:
          fileConfig.detection.conviction_size_mismatch.max_wallet_total_volume_usd,
        minFillToWalletVolumeRatio:
          fileConfig.detection.conviction_size_mismatch.min_fill_to_wallet_volume_ratio,
        longshotMaxPrice: fileConfig.detection.conviction_size_mismatch.longshot_max_price,
        minFillUsd: fileConfig.detection.conviction_size_mismatch.min_fill_usd,
      },
      lumpEntry: {
        minFillUsd: fileConfig.detection.lump_entry.min_fill_usd,
        minLumpRatio: fileConfig.detection.lump_entry.min_lump_ratio,
      },
      excludedCategories: fileConfig.detection.excluded_categories,
      cluster: {
        minSize: fileConfig.detection.cluster.min_size,
        minFillUsd: fileConfig.detection.cluster.min_fill_usd,
        elevatedFillUsd: fileConfig.detection.cluster.elevatedFillUsd,
        fundingMaxDepth: fileConfig.detection.cluster.funding_max_depth,
        fanoutLimit: fileConfig.detection.cluster.fanout_limit,
        maxRpcCalls: fileConfig.detection.cluster.max_rpc_calls,
        sameMarketSameSideWindowMs: fileConfig.detection.cluster.same_market_same_side_window_ms,
      },
      freshWalletLongshot: {
        enabled: fileConfig.signals.fresh_wallet_longshot.enabled,
        deliver: fileConfig.signals.fresh_wallet_longshot.deliver,
        maxAgeHours: fileConfig.signals.fresh_wallet_longshot.max_age_hours,
        maxTransactions: fileConfig.signals.fresh_wallet_longshot.max_txns,
        maxPrice: fileConfig.signals.fresh_wallet_longshot.max_price,
        minStakeUsd: fileConfig.signals.fresh_wallet_longshot.min_stake_usd,
        score: fileConfig.signals.fresh_wallet_longshot.score,
      },
    },
    filters: {
      excludeCategories: fileConfig.filters.exclude_categories,
    },
    alerts: {
      criticalMinScore: fileConfig.alerts.critical_min_score,
      highMinScore: fileConfig.alerts.high_min_score,
      mediumMinScore: fileConfig.alerts.medium_min_score,
      lowMinScore: fileConfig.alerts.low_min_score,
      dedupCooldownMs: fileConfig.alerts.dedup_cooldown_ms,
      dedupScoreIncrease: fileConfig.alerts.dedup_score_increase,
    },
    operational: {
      dryRun: envConfig.OMEN_OPERATIONAL_DRY_RUN ?? fileConfig.operational.dry_run,
    },
    backpressure: {
      hotWorkerQueueDepth:
        envConfig.OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH ??
        fileConfig.backpressure.hot_worker_queue_depth,
    },
    alchemy: {
      hotCuPerSecond: envConfig.OMEN_ALCHEMY_HOT_CU_PER_SECOND ?? fileConfig.alchemy.hot_cu_per_second,
      coldCuPerSecond: envConfig.OMEN_ALCHEMY_COLD_CU_PER_SECOND ?? fileConfig.alchemy.cold_cu_per_second,
      maxWaitMs: envConfig.OMEN_ALCHEMY_MAX_WAIT_MS ?? fileConfig.alchemy.max_wait_ms,
      maxQueue: fileConfig.alchemy.max_queue,
      max429Retries: fileConfig.alchemy.max_429_retries,
      minProfileFillUsd: envConfig.OMEN_ALCHEMY_MIN_PROFILE_FILL_USD ?? fileConfig.alchemy.min_profile_fill_usd,
      profileCacheTtlMs: envConfig.OMEN_ALCHEMY_PROFILE_CACHE_TTL_MS ?? fileConfig.alchemy.profile_cache_ttl_ms,
      persistedProfileTtlMs: fileConfig.alchemy.persisted_profile_ttl_ms,
      dailyCuBudget: envConfig.OMEN_ALCHEMY_DAILY_CU_BUDGET ?? fileConfig.alchemy.daily_cu_budget,
      hotBudgetShare: fileConfig.alchemy.hot_budget_share,
    },
    coldPath: {
      concurrency: envConfig.OMEN_COLD_PATH_CONCURRENCY ?? fileConfig.cold_path.concurrency,
      rebuildFailureCooldownMs:
        envConfig.OMEN_COLD_PATH_REBUILD_FAILURE_COOLDOWN_MS ??
        fileConfig.cold_path.rebuild_failure_cooldown_ms,
      shutdownTimeoutMs:
        envConfig.OMEN_COLD_PATH_SHUTDOWN_TIMEOUT_MS ?? fileConfig.cold_path.shutdown_timeout_ms,
      rebuildMinFillUsd: fileConfig.cold_path.rebuild_min_fill_usd,
      rebuildIfSignaled: fileConfig.cold_path.rebuild_if_signaled,
    },
    outcomes: {
      enabled: fileConfig.outcomes.enabled,
      intervalMs: fileConfig.outcomes.interval_ms,
      baselinePerSignal: fileConfig.outcomes.baseline_per_signal,
      baselineWindowHours: fileConfig.outcomes.baseline_window_hours,
    },
    feed: {
      enabled: fileConfig.feed.enabled,
      databaseUrl: process.env.FEED_DATABASE_URL?.trim() || null,
      publishLiveAlerts: fileConfig.feed.publish_live_alerts,
      syncOutcomes: fileConfig.feed.sync_outcomes,
      disableLegacyChannels: fileConfig.feed.disable_legacy_channels,
      xEnrich: fileConfig.feed.x_enrich,
      xMinTier: fileConfig.feed.x_min_tier,
      xAnnotateIntervalMs: fileConfig.feed.x_annotate_interval_ms,
      muteKalshi: fileConfig.feed.mute_kalshi,
    },
    kalshi: {
      enabled: fileConfig.kalshi.enabled,
      tradePollMs: fileConfig.kalshi.trade_poll_ms,
      marketCycleMs: fileConfig.kalshi.market_cycle_ms,
      storeMinNotionalUsd: fileConfig.kalshi.store_min_notional_usd,
      largePrintUsd: fileConfig.kalshi.large_print_usd,
      volumeSpikeMinHourUsd: fileConfig.kalshi.volume_spike_min_hour_usd,
      bookMoveMinCents: fileConfig.kalshi.book_move_min_cents,
      bookMoveWindowMs: fileConfig.kalshi.book_move_window_ms,
      depthPullRatio: fileConfig.kalshi.depth_pull_ratio,
      divergenceMinGap: fileConfig.kalshi.divergence_min_gap,
      bookWatchlistSize: fileConfig.kalshi.book_watchlist_size,
    },
    marketMaker: {
      filterEnabled: fileConfig.market_maker.filter_enabled,
      minScore: fileConfig.market_maker.min_score,
    },
  };
}

async function readTomlConfig(configPath: string): Promise<unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  const rawConfig = await readFile(configPath, 'utf8');
  if (rawConfig.trim().length === 0) {
    return {};
  }

  return toml.parse(rawConfig);
}

function readOptionalEnv(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
