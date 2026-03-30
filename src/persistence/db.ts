import { Pool } from 'pg';
import type { AppConfig } from '../config/schema.js';

export function createDbPool(config: Pick<AppConfig, 'databaseUrl'>): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 5,
  });
}

export async function pingDatabase(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query('select 1');
}
