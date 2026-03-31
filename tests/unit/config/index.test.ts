import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../../../src/config/index.js';

const ENV_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'ALCHEMY_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID_CRITICAL',
  'TELEGRAM_CHAT_ID_MEDIUM',
  'DISCORD_WEBHOOK_CRITICAL',
  'DISCORD_WEBHOOK_MEDIUM',
  'LOG_LEVEL',
  'LOG_PRETTY',
  'OMEN_INGESTION_POLL_INTERVAL_MS',
  'OMEN_INGESTION_MAX_PAGES_PER_POLL',
  'OMEN_OPERATIONAL_DRY_RUN',
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

[detection.fresh_wallet]
critical_age_hours = 12
elevated_age_hours = 48
max_txns = 4

[detection.market]
large_position_min_usd = 2500
large_position_volume_pct = 0.05

[alerts]
critical_min_score = 90
high_min_score = 70
medium_min_score = 50
low_min_score = 30
dedup_cooldown_ms = 60000

[operational]
dry_run = true

[backpressure]
hot_worker_queue_depth = 55
`.trimStart(),
      'utf8',
    );

    process.env.DATABASE_URL = 'postgresql://omen:omen@localhost:5432/omen';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.ALCHEMY_API_KEY = 'alchemy-key';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';
    process.env.TELEGRAM_CHAT_ID_CRITICAL = 'critical-chat';
    process.env.TELEGRAM_CHAT_ID_MEDIUM = 'medium-chat';
    process.env.DISCORD_WEBHOOK_CRITICAL = 'https://discord.example/critical';
    process.env.DISCORD_WEBHOOK_MEDIUM = 'https://discord.example/medium';

    const config = await loadAppConfig({ cwd });

    expect(config.configPath).toBe(join(cwd, 'omen.config.toml'));
    expect(config.ingestion.pollIntervalMs).toBe(12_345);
    expect(config.ingestion.maxPagesPerPoll).toBe(7);
    expect(config.detection.freshWallet.criticalAgeHours).toBe(12);
    expect(config.detection.freshWallet.elevatedAgeHours).toBe(48);
    expect(config.detection.freshWallet.maxTransactions).toBe(4);
    expect(config.detection.market.largePositionMinUsd).toBe(2500);
    expect(config.detection.market.largePositionVolumePct).toBe(0.05);
    expect(config.alerts.highMinScore).toBe(70);
    expect(config.alerts.dedupCooldownMs).toBe(60_000);
    expect(config.operational.dryRun).toBe(true);
    expect(config.backpressure.hotWorkerQueueDepth).toBe(55);
    expect(config.alchemyApiKey).toBe('alchemy-key');
    expect(config.telegram.botToken).toBe('telegram-token');
    expect(config.telegram.criticalChatId).toBe('critical-chat');
    expect(config.telegram.mediumChatId).toBe('medium-chat');
    expect(config.discord.criticalWebhookUrl).toBe('https://discord.example/critical');
    expect(config.discord.mediumWebhookUrl).toBe('https://discord.example/medium');
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
    process.env.ALCHEMY_API_KEY = 'alchemy-key';
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_PRETTY = 'false';
    process.env.OMEN_INGESTION_POLL_INTERVAL_MS = '5000';
    process.env.OMEN_INGESTION_MAX_PAGES_PER_POLL = '3';
    process.env.OMEN_OPERATIONAL_DRY_RUN = 'true';
    process.env.OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH = '25';

    const config = await loadAppConfig({ cwd });

    expect(config.ingestion.pollIntervalMs).toBe(5000);
    expect(config.ingestion.maxPagesPerPoll).toBe(3);
    expect(config.backpressure.hotWorkerQueueDepth).toBe(25);
    expect(config.operational.dryRun).toBe(true);
    expect(config.logLevel).toBe('debug');
    expect(config.logPretty).toBe(false);
  });

  it('rejects invalid Discord webhook URLs early', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omen-config-'));
    await writeFile(join(cwd, 'omen.config.toml'), '', 'utf8');

    process.env.DATABASE_URL = 'postgresql://omen:omen@localhost:5432/omen';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.DISCORD_WEBHOOK_CRITICAL = 'htps://discord.example/not-a-real-url';

    await expect(loadAppConfig({ cwd })).rejects.toThrow(/HTTPS URL/i);
  });
});
