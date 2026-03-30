import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../../../src/config/index.js';

const ENV_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'LOG_LEVEL',
  'LOG_PRETTY',
  'OMEN_INGESTION_POLL_INTERVAL_MS',
  'OMEN_INGESTION_MAX_PAGES_PER_POLL',
  'OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH',
] as const;

describe('loadAppConfig', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('loads config from TOML and required env variables', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omen-config-'));
    await writeFile(
      join(cwd, 'omen.config.toml'),
      `
[ingestion]
poll_interval_ms = 12345
max_pages_per_poll = 7

[backpressure]
hot_worker_queue_depth = 55
`.trimStart(),
      'utf8',
    );

    process.env.DATABASE_URL = 'postgresql://omen:omen@localhost:5432/omen';
    process.env.REDIS_URL = 'redis://localhost:6379';

    const config = await loadAppConfig({ cwd });

    expect(config.configPath).toBe(join(cwd, 'omen.config.toml'));
    expect(config.ingestion.pollIntervalMs).toBe(12_345);
    expect(config.ingestion.maxPagesPerPoll).toBe(7);
    expect(config.backpressure.hotWorkerQueueDepth).toBe(55);
    expect(config.logLevel).toBe('info');
    expect(config.logPretty).toBe(true);
  });

  it('applies env overrides on top of TOML values', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omen-config-'));
    await writeFile(
      join(cwd, 'omen.config.toml'),
      `
[ingestion]
poll_interval_ms = 15000
max_pages_per_poll = 20

[backpressure]
hot_worker_queue_depth = 100
`.trimStart(),
      'utf8',
    );

    process.env.DATABASE_URL = 'postgresql://omen:omen@localhost:5432/omen';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_PRETTY = 'false';
    process.env.OMEN_INGESTION_POLL_INTERVAL_MS = '5000';
    process.env.OMEN_INGESTION_MAX_PAGES_PER_POLL = '3';
    process.env.OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH = '25';

    const config = await loadAppConfig({ cwd });

    expect(config.ingestion.pollIntervalMs).toBe(5000);
    expect(config.ingestion.maxPagesPerPoll).toBe(3);
    expect(config.backpressure.hotWorkerQueueDepth).toBe(25);
    expect(config.logLevel).toBe('debug');
    expect(config.logPretty).toBe(false);
  });
});
