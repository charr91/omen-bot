import type { JsonObject, JsonValue, TradeSide } from './types.js';

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value;
}

export function getJsonObject(value: JsonObject, keys: string[]): JsonObject | null {
  for (const key of keys) {
    const candidate = value[key];
    if (isJsonObject(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function getJsonArray(value: JsonObject, keys: string[]): JsonValue[] | null {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function getString(value: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

export function getNumber(value: JsonObject, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.length > 0) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

export function getBoolean(value: JsonObject, keys: string[]): boolean | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'boolean') {
      return candidate;
    }
  }

  return null;
}

export function parseTimestampMs(raw: string | number): number {
  if (typeof raw === 'number') {
    return normalizeEpoch(raw);
  }

  if (/^\d+(\.\d+)?$/.test(raw)) {
    return normalizeEpoch(Number(raw));
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${raw}`);
  }

  return parsed;
}

export function normalizeEpoch(value: number): number {
  if (value >= 1_000_000_000_000_000) {
    return Math.trunc(value / 1_000);
  }

  if (value >= 1_000_000_000_000) {
    return Math.trunc(value);
  }

  return Math.trunc(value * 1000);
}

export function normalizeSide(value: string | null): TradeSide {
  if (value === 'BUY' || value === 'SELL') {
    return value;
  }

  return 'UNKNOWN';
}

export function parseStringArray(input: JsonValue[] | string | null): string[] {
  if (Array.isArray(input)) {
    return input.filter((item): item is string => typeof item === 'string');
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      return input
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }
  }

  return [];
}

export function stableObservationKey(parts: Array<string | number | null>): string {
  return parts.map((part) => (part === null ? 'null' : String(part))).join('|');
}
