import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

interface LoadEnvironmentOptions {
  cwd?: string;
  envFiles?: string[];
}

export function loadEnvironment(options: LoadEnvironmentOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const explicitEnvFiles = options.envFiles && options.envFiles.length > 0 ? options.envFiles : null;
  const candidateFiles = explicitEnvFiles ?? ['.env.local', '.env'];
  const loadedFiles: string[] = [];

  for (const candidate of candidateFiles) {
    const filePath = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (explicitEnvFiles === null && !existsSync(filePath)) {
      continue;
    }

    try {
      process.loadEnvFile(filePath);
      loadedFiles.push(filePath);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : null;
      if (explicitEnvFiles === null && code === 'ENOENT') {
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load env file ${filePath}: ${message}`);
    }
  }

  return loadedFiles;
}

