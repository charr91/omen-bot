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
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    LOG_PRETTY: process.env.LOG_PRETTY ?? 'true',
    OMEN_INGESTION_POLL_INTERVAL_MS: process.env.OMEN_INGESTION_POLL_INTERVAL_MS,
    OMEN_INGESTION_MAX_PAGES_PER_POLL: process.env.OMEN_INGESTION_MAX_PAGES_PER_POLL,
    OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH: process.env.OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH,
  });

  return {
    configPath,
    databaseUrl: envConfig.DATABASE_URL,
    redisUrl: envConfig.REDIS_URL,
    logLevel: envConfig.LOG_LEVEL,
    logPretty: envConfig.LOG_PRETTY,
    ingestion: {
      pollIntervalMs: envConfig.OMEN_INGESTION_POLL_INTERVAL_MS ?? fileConfig.ingestion.poll_interval_ms,
      maxPagesPerPoll: envConfig.OMEN_INGESTION_MAX_PAGES_PER_POLL ?? fileConfig.ingestion.max_pages_per_poll,
    },
    backpressure: {
      hotWorkerQueueDepth:
        envConfig.OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH ??
        fileConfig.backpressure.hot_worker_queue_depth,
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
