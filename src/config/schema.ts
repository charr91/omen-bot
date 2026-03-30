import { z } from 'zod';

const booleanStringSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const positiveIntegerStringSchema = z
  .string()
  .min(1)
  .transform((value) => Number(value))
  .pipe(z.number().int().positive());

export const fileConfigSchema = z
  .object({
    ingestion: z
      .object({
        poll_interval_ms: z.number().int().positive().optional(),
        max_pages_per_poll: z.number().int().positive().optional(),
      })
      .optional(),
    backpressure: z
      .object({
        hot_worker_queue_depth: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .transform((value) => ({
    ingestion: {
      poll_interval_ms: value.ingestion?.poll_interval_ms ?? 15_000,
      max_pages_per_poll: value.ingestion?.max_pages_per_poll ?? 20,
    },
    backpressure: {
      hot_worker_queue_depth: value.backpressure?.hot_worker_queue_depth ?? 100,
    },
  }));

export const envConfigSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  LOG_PRETTY: booleanStringSchema,
  OMEN_INGESTION_POLL_INTERVAL_MS: positiveIntegerStringSchema.optional(),
  OMEN_INGESTION_MAX_PAGES_PER_POLL: positiveIntegerStringSchema.optional(),
  OMEN_BACKPRESSURE_HOT_WORKER_QUEUE_DEPTH: positiveIntegerStringSchema.optional(),
});

export type FileConfig = z.infer<typeof fileConfigSchema>;
export type EnvConfig = z.infer<typeof envConfigSchema>;

export interface AppConfig {
  configPath: string;
  databaseUrl: string;
  redisUrl: string;
  logLevel: EnvConfig['LOG_LEVEL'];
  logPretty: boolean;
  ingestion: {
    pollIntervalMs: number;
    maxPagesPerPoll: number;
  };
  backpressure: {
    hotWorkerQueueDepth: number;
  };
}
