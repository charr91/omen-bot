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

const CREATE_WALLETS_TABLE_SQL = `
  create table if not exists wallets (
    address text primary key,
    age_seconds integer not null default 0,
    activity_age_known boolean not null default true,
    total_transactions integer not null default 0,
    is_contract boolean not null default false,
    controller_address text,
    first_seen_at timestamptz not null,
    last_active_at timestamptz not null,
    total_markets integer not null default 0,
    total_fills integer not null default 0,
    total_volume_usd numeric(20, 6) not null default 0,
    resolved_positions integer not null default 0,
    wins integer not null default 0,
    win_rate double precision,
    avg_edge_at_entry double precision,
    edge_ttest_p_value double precision,
    total_pnl_usd numeric(20, 6) not null default 0,
    category_concentration double precision,
    top_categories jsonb not null default '[]'::jsonb,
    avg_entry_timing_minutes double precision,
    pre_resolution_ratio double precision,
    avg_position_size_pct double precision,
    lump_entry_ratio double precision,
    conviction_ratio double precision,
    funding_cluster_id text,
    funding_graph_built_at timestamptz,
    live_suspicion_score double precision not null default 0,
    retrospective_score double precision not null default 0,
    live_tier text not null default 'CLEAN',
    retrospective_tier text not null default 'CLEAN',
    is_whitelisted boolean not null default false,
    labels jsonb not null default '[]'::jsonb,
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

const CREATE_WALLETS_SUPPORTING_INDEXES_SQL = [
  'create index if not exists idx_wallets_live_score on wallets (live_suspicion_score);',
  'create index if not exists idx_wallets_retro_score on wallets (retrospective_score);',
  'create index if not exists idx_wallets_live_tier on wallets (live_tier);',
  'create index if not exists idx_wallets_cluster on wallets (funding_cluster_id);',
];

const CREATE_SIGNAL_EVENTS_TABLE_SQL = `
  create table if not exists signal_events (
    id text primary key,
    wallet_address text not null,
    market_id text,
    fill_id text,
    signal_id text not null,
    availability text not null,
    score double precision not null,
    confidence double precision not null,
    evidence jsonb not null,
    scoring_version text not null,
    created_at timestamptz not null default now()
  );
`;

const CREATE_SIGNAL_EVENTS_SUPPORTING_INDEXES_SQL = [
  'create unique index if not exists idx_signal_events_live_idemp on signal_events (fill_id, signal_id);',
  'create unique index if not exists idx_signal_events_retro_idemp on signal_events (wallet_address, market_id, signal_id) where fill_id is null;',
  'create index if not exists idx_signal_events_wallet on signal_events (wallet_address);',
  'create index if not exists idx_signal_events_signal on signal_events (signal_id);',
  'create index if not exists idx_signal_events_market on signal_events (market_id);',
  'create index if not exists idx_signal_events_created on signal_events (created_at);',
  'create index if not exists idx_signal_events_version on signal_events (scoring_version);',
];

const CREATE_WHALE_WHITELIST_TABLE_SQL = `
  create table if not exists whale_whitelist (
    wallet_address text primary key,
    reason text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

export async function ensurePersistenceSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(CREATE_FILLS_TABLE_SQL);
  await pool.query(CREATE_FILLS_UNIQUE_INDEX_SQL);
  for (const statement of CREATE_FILLS_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_WALLETS_TABLE_SQL);
  await pool.query("alter table wallets add column if not exists activity_age_known boolean not null default true;");
  for (const statement of CREATE_WALLETS_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_SIGNAL_EVENTS_TABLE_SQL);
  for (const statement of CREATE_SIGNAL_EVENTS_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_WHALE_WHITELIST_TABLE_SQL);
}
