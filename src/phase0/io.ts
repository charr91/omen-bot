import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface JsonlWriter<T> {
  write(record: T): Promise<void>;
  close(): Promise<void>;
}

export async function ensureDirectory(pathname: string): Promise<void> {
  await mkdir(pathname, { recursive: true });
}

export async function writeJsonFile(pathname: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(pathname));
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeTextFile(pathname: string, value: string): Promise<void> {
  await ensureDirectory(dirname(pathname));
  await writeFile(pathname, `${value}\n`, 'utf8');
}

export async function readJsonFile(pathname: string): Promise<unknown> {
  const content = await readFile(pathname, 'utf8');
  return JSON.parse(content);
}

export function createJsonlWriter<T>(pathname: string): JsonlWriter<T> {
  let chain = ensureDirectory(dirname(pathname));

  return {
    async write(record: T): Promise<void> {
      chain = chain.then(async () => appendFile(pathname, `${JSON.stringify(record)}\n`, 'utf8'));
      await chain;
    },
    async close(): Promise<void> {
      await chain;
    },
  };
}

export async function readJsonLines(pathname: string): Promise<unknown[]> {
  const content = await readFile(pathname, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
