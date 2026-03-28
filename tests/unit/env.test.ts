import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvironment } from '../../src/env.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

describe('environment loading', () => {
  it('loads default .env.local before .env so local values win', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omen-env-'));

    try {
      writeFileSync(join(directory, '.env.local'), 'POLY_PRIVATE_KEY=local-key\n');
      writeFileSync(join(directory, '.env'), 'POLY_PRIVATE_KEY=base-key\nPOLY_FUNDER=base-funder\n');

      const loaded = loadEnvironment({ cwd: directory });

      expect(loaded).toHaveLength(2);
      expect(process.env.POLY_PRIVATE_KEY).toBe('local-key');
      expect(process.env.POLY_FUNDER).toBe('base-funder');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not override already-exported environment variables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omen-env-'));

    try {
      process.env.POLY_PRIVATE_KEY = 'exported-key';
      writeFileSync(join(directory, '.env'), 'POLY_PRIVATE_KEY=file-key\nPOLY_FUNDER=file-funder\n');

      loadEnvironment({ cwd: directory });

      expect(process.env.POLY_PRIVATE_KEY).toBe('exported-key');
      expect(process.env.POLY_FUNDER).toBe('file-funder');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads explicit env files and throws if one is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omen-env-'));

    try {
      const envFile = join(directory, 'server.env');
      writeFileSync(envFile, 'POLY_PRIVATE_KEY=explicit-key\n');

      const loaded = loadEnvironment({ envFiles: [envFile] });
      expect(loaded).toEqual([envFile]);
      expect(process.env.POLY_PRIVATE_KEY).toBe('explicit-key');

      expect(() => loadEnvironment({ envFiles: [join(directory, 'missing.env')] })).toThrow(
        'Failed to load env file',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
