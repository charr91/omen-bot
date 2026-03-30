#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
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

const HELP = `omen validate-fills

Phase 1 thin slice + Phase 0 validation.

Usage:
  omen [--env-file .env] start
  omen [--env-file .env] replay
  omen [--env-file .env] health
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

  const [scope, action, ...rest] = parsed.positionals;

  if (scope === 'start' && !action) {
    await runStartCommand();
    return;
  }

  if (scope === 'replay' && !action) {
    await runReplayCommand();
    return;
  }

  if (scope === 'health' && !action) {
    await runHealthCommand();
    return;
  }

  if (scope !== 'validate-fills' || !action) {
    throw new Error(HELP);
  }

  if (action === 'capture') {
    const options = parseCaptureOptions(rest);

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
    const options = parseAnalyzeOptions(rest);
    const result = await runPhase0Analysis(options.input);
    process.stdout.write(
      `${result.summaryPath}\n${result.findingsPath}\n${result.summary.recommendation.naturalKey}\n`,
    );
    return;
  }

  throw new Error(HELP);
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

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
