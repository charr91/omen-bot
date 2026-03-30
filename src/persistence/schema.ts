import type { Pool } from 'pg';

const CREATE_FILLS_TABLE_SQL = `
  create table if not exists fills (
    id text primary key,
    market_id text not null,
    token_id text not null,
    wallet_address text not null,
    side text not null,
    outcome text not null,
    price numeric(10, 6) not null,
    shares numeric(20, 6) not null,
    size_usd numeric(20, 6) not null,
    tx_hash text not null,
    order_type text not null,
    timestamp timestamptz not null,
    analyzed boolean not null default false,
    created_at timestamptz not null default now()
  );
`;

const CREATE_FILLS_UNIQUE_INDEX_SQL = `
  create unique index if not exists idx_fills_unique
  on fills (tx_hash, token_id);
`;

const CREATE_FILLS_SUPPORTING_INDEXES_SQL = [
  'create index if not exists idx_fills_wallet on fills (wallet_address);',
  'create index if not exists idx_fills_market on fills (market_id);',
  'create index if not exists idx_fills_timestamp on fills (timestamp);',
  'create index if not exists idx_fills_unanalyzed on fills (analyzed) where analyzed = false;',
];

export async function ensurePersistenceSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(CREATE_FILLS_TABLE_SQL);
  await pool.query(CREATE_FILLS_UNIQUE_INDEX_SQL);
  for (const statement of CREATE_FILLS_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }
}
