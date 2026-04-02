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
    timestamp: false,
    messageKey: 'message',
    formatters: {
      bindings: (bindings) => bindings,
      level: () => ({}),
    },
  };

  return Object.keys(bindings).length === 0 ? pino(options) : pino(options).child(bindings);
}

export function emitStructuredLog<T extends object>(logger: Logger, payload: T): void {
  logger.info(sanitizeForLogPayload(payload));
}
