import { loadAppConfig } from '../config/index.js';
import { createDbPool } from '../persistence/db.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { createMarketMakerStore } from '../persistence/queries/market-maker.js';
import { buildStatsReport, formatStatsTable } from './stats.js';
import { createTradeOutcomeStore } from './store.js';
import { OutcomeTracker } from './tracker.js';

export interface StatsCommandOptions {
  days: number;
  json: boolean;
  /** Run one grading pass before reporting (useful when the engine is not running). */
  refresh: boolean;
}

export function parseStatsOptions(args: string[]): StatsCommandOptions {
  const options: StatsCommandOptions = { days: 7, json: false, refresh: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json') options.json = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--days' || arg.startsWith('--days=')) {
      const raw = arg.includes('=') ? arg.slice('--days='.length) : args[++i];
      const days = Number(raw);
      if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
      options.days = days;
    } else {
      throw new Error(`Unknown stats option: ${arg}`);
    }
  }
  return options;
}

export async function runStatsCommand(options: StatsCommandOptions): Promise<string> {
  const config = await loadAppConfig();
  const pool = createDbPool(config);
  try {
    await ensurePersistenceSchema(pool);
    const store = createTradeOutcomeStore(pool);
    if (options.refresh) {
      await new OutcomeTracker({
        store,
        marketMakers: createMarketMakerStore(pool),
        baselinePerSignal: config.outcomes.baselinePerSignal,
        baselineWindowHours: config.outcomes.baselineWindowHours,
        marketMakerMinScore: config.marketMaker.minScore,
      }).runOnce();
    }

    const since = new Date(Date.now() - options.days * 86_400_000);
    const rows = await store.listOutcomes(since);
    const report = buildStatsReport(rows);
    if (options.json) {
      return JSON.stringify({ since: since.toISOString(), ...report }, null, 2);
    }

    const signals = rows.filter((r) => r.kind === 'signal').length;
    const baselines = rows.length - signals;
    return [
      `omen stats: last ${options.days} day(s) since ${since.toISOString()}`,
      `${signals} signal fills, ${baselines} baseline fills (same market, +/-${config.outcomes.baselineWindowHours}h, 0.5-2x size).`,
      'hit = price moved in the trade direction (BUY up / SELL down); n = priced fills whose price moved (unchanged prices excluded); edge = signal minus baseline hit rate.',
      '',
      formatStatsTable('By signal', report.bySignal),
      '',
      formatStatsTable('By alert tier (NO_ALERT = signal not promoted)', report.byTier),
    ].join('\n');
  } finally {
    await pool.end();
  }
}
