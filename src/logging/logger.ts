import pino, { type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '../config/schema.js';
import { sanitizeForLogPayload } from '../resilience/sanitizer.js';

export function createAppLogger(
  config: Pick<AppConfig, 'logLevel' | 'logPretty'>,
  bindings: Record<string, string | number | boolean | null> = {},
): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: undefined,
    // box-dry-run: pino 10 emits invalid JSON ('{,') when the level formatter returns {};
    // emit an ISO timestamp and a non-colliding severity key instead.
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: {
      bindings: (bindings) => bindings,
      level: (label) => ({ severity: label }),
    },
  };

  return Object.keys(bindings).length === 0 ? pino(options) : pino(options).child(bindings);
}

export function emitStructuredLog<T extends object>(logger: Logger, payload: T): void {
  logger.info(sanitizeForLogPayload(payload));
}
