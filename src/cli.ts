#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runProxyOverrideCommand, runQuarantineCommand, runWhitelistCommand } from './admin/commands.js';
import { sendTestTelegramAlert } from './alerts/test-telegram.js';
import { runColdWorkerCommand } from './cold-path/runtime.js';
import { parseStatsOptions, runStatsCommand } from './outcomes/command.js';
import { runKalshiMapCommand } from './kalshi/command.js';
import { runHealthCommand, runReplayCommand, runStartCommand } from './engine/index.js';
import { loadEnvironment } from './env.js';
import { runPhase0Analysis } from './phase0/analyze.js';
import { defaultDetachedCaptureLogPath, runPhase0Capture } from './phase0/capture.js';

interface CaptureCliOptions {
  hours: number;
  out: string;
  useAuth: boolean;
  detach: boolean;
}

interface AnalyzeCliOptions {
  input: string;
}

interface StartCliOptions {
  tui: boolean;
}

const HELP = `omen validate-fills

Phase 1 thin slice + Phase 0 validation.

Usage:
  omen [--env-file .env] start [--tui]
  omen [--env-file .env] replay
  omen [--env-file .env] health
  omen [--env-file .env] stats [--days 7] [--json] [--refresh]
  omen [--env-file .env] kalshi-map <list|add|remove|suggest [--auto] [--min 0.6]> [...]
  omen [--env-file .env] test-telegram
  omen [--env-file .env] cold-worker
  omen [--env-file .env] whitelist <list|add|remove> [...]
  omen [--env-file .env] proxy-override <list|set|clear> [...]
  omen [--env-file .env] quarantine <list|show> [...]
  omen [--env-file .env.server] validate-fills capture --hours 24 --out .phase0-data/run-001 [--use-auth] [--detach]
  omen [--env-file .env.server] validate-fills analyze --input .phase0-data/run-001

Environment:
  Loads .env.local then .env from the current working directory by default.
  Existing exported environment variables override file values.
  Repeat --env-file to load additional explicit files.
`;

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const parsed = parseGlobalOptions(argv);
  loadEnvironment(parsed.envFiles.length > 0 ? { envFiles: parsed.envFiles } : undefined);

  const [scope, ...rest] = parsed.positionals;

  if (scope === 'start') {
    const options = parseStartOptions(rest);
    await runStartCommand(options);
    // All workers, queues and pools are closed by now; exit so a stray handle cannot keep SIGTERM shutdown hanging.
    process.exit(process.exitCode ?? 0);
  }

  if (scope === 'replay' && rest.length === 0) {
    await runReplayCommand();
    return;
  }

  if (scope === 'stats') {
    process.stdout.write(`${await runStatsCommand(parseStatsOptions(rest))}\n`);
    return;
  }

  if (scope === 'kalshi-map') {
    process.stdout.write(`${await runKalshiMapCommand(rest)}\n`);
    return;
  }

  if (scope === 'health' && rest.length === 0) {
    await runHealthCommand();
    return;
  }

  if (scope === 'test-telegram' && rest.length === 0) {
    const alert = await sendTestTelegramAlert({
      telegram: {
        botToken: readOptionalEnv(process.env.TELEGRAM_BOT_TOKEN),
        criticalChatId: readOptionalEnv(process.env.TELEGRAM_CHAT_ID_CRITICAL),
        mediumChatId: readOptionalEnv(process.env.TELEGRAM_CHAT_ID_MEDIUM),
      },
    });
    process.stdout.write(`${alert.promotedAt}\n`);
    return;
  }

  if (scope === 'cold-worker' && rest.length === 0) {
    await runColdWorkerCommand();
    return;
  }

  if (scope === 'whitelist') {
    await runWhitelistCommand(rest);
    return;
  }

  if (scope === 'proxy-override') {
    await runProxyOverrideCommand(rest);
    return;
  }

  if (scope === 'quarantine') {
    await runQuarantineCommand(rest);
    return;
  }

  const [action, ...actionArgs] = rest;

  if (scope !== 'validate-fills' || !action) {
    throw new Error(HELP);
  }

  if (action === 'capture') {
    const options = parseCaptureOptions(actionArgs);

    if (options.detach) {
      const result = await spawnDetachedCapture(parsed.envFiles, options);
      process.stdout.write(`${result.pid}\n${result.runDirectory}\n${result.logPath}\n`);
      return;
    }

    const result = await runPhase0Capture(options);
    process.stdout.write(`${result.runDirectory}\n`);
    return;
  }

  if (action === 'analyze') {
    const options = parseAnalyzeOptions(actionArgs);
    const result = await runPhase0Analysis(options.input);
    process.stdout.write(
      `${result.summaryPath}\n${result.findingsPath}\n${result.summary.recommendation.naturalKey}\n`,
    );
    return;
  }

  throw new Error(HELP);
}

function parseStartOptions(args: string[]): StartCliOptions {
  const parsed = parseArgs({
    args,
    options: {
      tui: {
        type: 'boolean',
        default: false,
      },
    },
    allowPositionals: false,
  });

  return {
    tui: parsed.values.tui ?? false,
  };
}

async function spawnDetachedCapture(
  envFiles: string[],
  options: CaptureCliOptions,
): Promise<{
  pid: number;
  runDirectory: string;
  logPath: string;
}> {
  const runDirectory = resolve(options.out);
  const logPath = defaultDetachedCaptureLogPath(runDirectory);
  await mkdir(runDirectory, { recursive: true });

  const cliPath = fileURLToPath(import.meta.url);
  const args: string[] = [cliPath];
  for (const envFile of envFiles) {
    args.push('--env-file', envFile);
  }
  args.push('validate-fills', 'capture', '--hours', String(options.hours), '--out', options.out);
  if (options.useAuth) {
    args.push('--use-auth');
  }

  const outputFd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: ['ignore', outputFd, outputFd],
    });
    child.unref();

    if (!child.pid) {
      throw new Error('Detached capture failed to return a child pid');
    }

    return {
      pid: child.pid,
      runDirectory,
      logPath,
    };
  } finally {
    closeSync(outputFd);
  }
}

function parseGlobalOptions(args: string[]): {
  envFiles: string[];
  positionals: string[];
} {
  const envFiles: string[] = [];
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--env-file') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--env-file requires a path');
      }

      envFiles.push(next);
      index += 1;
      continue;
    }

    if (arg.startsWith('--env-file=')) {
      const value = arg.slice('--env-file='.length);
      if (!value) {
        throw new Error('--env-file requires a path');
      }

      envFiles.push(value);
      continue;
    }

    positionals.push(arg);
  }

  return {
    envFiles,
    positionals,
  };
}

function parseCaptureOptions(args: string[]): CaptureCliOptions {
  const parsed = parseArgs({
    args,
    options: {
      hours: {
        type: 'string',
        default: '24',
      },
      out: {
        type: 'string',
        default: `.phase0-data/run-${new Date().toISOString().replaceAll(':', '-')}`,
      },
      'use-auth': {
        type: 'boolean',
        default: false,
      },
      detach: {
        type: 'boolean',
        default: false,
      },
    },
    allowPositionals: false,
  });

  const hours = Number(parsed.values.hours);

  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('--hours must be a positive number');
  }

  return {
    hours,
    out: parsed.values.out,
    useAuth: parsed.values['use-auth'],
    detach: parsed.values.detach,
  };
}

function parseAnalyzeOptions(args: string[]): AnalyzeCliOptions {
  const parsed = parseArgs({
    args,
    options: {
      input: {
        type: 'string',
      },
    },
    allowPositionals: false,
  });

  if (!parsed.values.input) {
    throw new Error('--input is required');
  }

  return {
    input: parsed.values.input,
  };
}

function readOptionalEnv(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
