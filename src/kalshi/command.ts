import { loadAppConfig } from '../config/index.js';
import { createDbPool } from '../persistence/db.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { createKalshiStore } from './store.js';

/** omen kalshi-map <list|add|remove>: Polymarket market id (condition id) <-> Kalshi ticker pairs for divergence. */
export async function runKalshiMapCommand(args: string[]): Promise<string> {
  const [action, ...rest] = args;
  const config = await loadAppConfig();
  const pool = createDbPool(config);
  try {
    await ensurePersistenceSchema(pool);
    const store = createKalshiStore(pool);
    if (action === 'list') {
      const rows = await store.listMappings();
      if (rows.length === 0) return 'No mappings.';
      return rows
        .map((m) => `${m.polymarketMarketId}  ${m.kalshiTicker}${m.invert ? '  (inverted)' : ''}${m.note ? `  # ${m.note}` : ''}`)
        .join('\n');
    }
    if (action === 'add') {
      const invert = rest.includes('--invert');
      const noteIndex = rest.indexOf('--note');
      const note = noteIndex >= 0 ? rest[noteIndex + 1] ?? null : null;
      const positional = rest.filter((arg, i) => !arg.startsWith('--') && i !== noteIndex + 1);
      const [polymarketMarketId, kalshiTicker] = positional;
      if (!polymarketMarketId || !kalshiTicker) throw new Error('usage: kalshi-map add <polymarketMarketId> <kalshiTicker> [--invert] [--note text]');
      await store.addMapping({ polymarketMarketId, kalshiTicker, invert, note });
      return `Mapped ${polymarketMarketId} -> ${kalshiTicker}${invert ? ' (inverted)' : ''}`;
    }
    if (action === 'remove') {
      const [polymarketMarketId, kalshiTicker] = rest;
      if (!polymarketMarketId || !kalshiTicker) throw new Error('usage: kalshi-map remove <polymarketMarketId> <kalshiTicker>');
      return (await store.removeMapping(polymarketMarketId, kalshiTicker)) ? 'Removed.' : 'Not found.';
    }
    throw new Error('usage: kalshi-map <list|add|remove> [...]');
  } finally {
    await pool.end();
  }
}
