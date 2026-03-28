#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { runPhase0Analysis } from './phase0/analyze.js';
import { runPhase0Capture } from './phase0/capture.js';

interface CaptureCliOptions {
  hours: number;
  out: string;
  useAuth: boolean;
}

interface AnalyzeCliOptions {
  input: string;
}

const HELP = `omen validate-fills

Phase 0 only.

Usage:
  omen validate-fills capture --hours 24 --out .phase0-data/run-001 [--use-auth]
  omen validate-fills analyze --input .phase0-data/run-001
`;

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const [scope, action, ...rest] = argv;

  if (scope !== 'validate-fills' || !action) {
    throw new Error(HELP);
  }

  if (action === 'capture') {
    const options = parseCaptureOptions(rest);
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

