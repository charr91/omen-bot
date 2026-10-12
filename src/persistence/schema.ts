import { CREATE_TRADE_OUTCOMES_INDEXES_SQL, CREATE_TRADE_OUTCOMES_TABLE_SQL } from '../outcomes/store.js';
import type { Pool } from 'pg';
import { KALSHI_SCHEMA_SQL } from '../kalshi/store.js';
import { FEED_SYNC_SCHEMA_SQL } from '../feed/publisher.js';
import { X_CONTEXT_SCHEMA_SQL } from '../feed/x-enrich.js';

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
  'create index if not exists idx_fills_wallet_canonical on fills ((lower(wallet_address)));',
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

const CREATE_FUNDING_EDGES_TABLE_SQL = `
  create table if not exists funding_edges (
    id text primary key,
    root_wallet text not null,
    from_address text not null,
    to_address text not null,
    amount_usd numeric(20, 6) not null,
    asset text not null,
    tx_hash text not null,
    timestamp timestamptz not null,
    depth integer not null,
    created_at timestamptz not null default now()
  );
`;

const CREATE_FUNDING_EDGES_SUPPORTING_INDEXES_SQL = [
  'create index if not exists idx_funding_edges_root on funding_edges (root_wallet);',
  'create index if not exists idx_funding_edges_root_canonical on funding_edges ((lower(root_wallet)));',
  'create index if not exists idx_funding_edges_ancestor on funding_edges (from_address);',
  'create index if not exists idx_funding_edges_ancestor_canonical on funding_edges ((lower(from_address)));',
  'create index if not exists idx_funding_edges_tx_hash on funding_edges (tx_hash);',
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

const CREATE_ALERTS_TABLE_SQL = `
  create table if not exists alerts (
    id text primary key,
    wallet_address text not null,
    market_id text not null,
    fill_id text not null,
    signal_id text not null,
    signal_availability text not null,
    signal_score double precision not null,
    signal_confidence double precision not null,
    signal_evidence jsonb not null,
    signal_triggered_at timestamptz not null,
    scoring_version text not null,
    market_question text not null,
    market_url text,
    wallet_live_score double precision not null,
    wallet_live_tier text not null,
    delivery_tier text not null,
    dry_run boolean not null default false,
    dispatch_eligible boolean not null default false,
    promoted_at timestamptz not null default now(),
    created_at timestamptz not null default now()
  );
`;

const CREATE_ALERTS_SUPPORTING_INDEXES_SQL = [
  'create unique index if not exists idx_alerts_idemp on alerts (fill_id, signal_id);',
  'create index if not exists idx_alerts_wallet on alerts (wallet_address);',
  'create index if not exists idx_alerts_market on alerts (market_id);',
  'create index if not exists idx_alerts_promoted_at on alerts (promoted_at);',
  'create index if not exists idx_alerts_delivery_tier on alerts (delivery_tier);',
  'create index if not exists idx_alerts_dispatch_eligible on alerts (dispatch_eligible) where dispatch_eligible = true;',
];

const CREATE_ALERT_DELIVERIES_TABLE_SQL = `
  create table if not exists alert_deliveries (
    id text primary key,
    alert_id text not null,
    channel text not null,
    status text not null,
    error_message text,
    attempts integer not null default 1,
    first_attempted_at timestamptz not null default now(),
    last_attempted_at timestamptz not null default now(),
    delivered_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

const CREATE_ALERT_DELIVERIES_SUPPORTING_INDEXES_SQL = [
  'create unique index if not exists idx_alert_deliveries_alert_channel on alert_deliveries (alert_id, channel);',
  'create index if not exists idx_alert_deliveries_status on alert_deliveries (status);',
  'create index if not exists idx_alert_deliveries_channel on alert_deliveries (channel);',
  'create index if not exists idx_alert_deliveries_last_attempted on alert_deliveries (last_attempted_at);',
];

const CREATE_WHALE_WHITELIST_TABLE_SQL = `
  create table if not exists whale_whitelist (
    wallet_address text primary key,
    label text not null default '',
    reason text not null,
    added_by text not null default 'manual',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

const CREATE_WHALE_WHITELIST_SUPPORTING_INDEXES_SQL = [
  'create index if not exists idx_whale_whitelist_wallet_canonical on whale_whitelist ((lower(wallet_address)));',
];

const CREATE_PROXY_OVERRIDES_TABLE_SQL = `
  create table if not exists proxy_overrides (
    contract_address text primary key,
    controller_address text not null,
    reason text not null,
    added_by text not null default 'manual',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

const CREATE_PROXY_OVERRIDES_SUPPORTING_INDEXES_SQL = [
  'create index if not exists idx_proxy_overrides_contract_canonical on proxy_overrides ((lower(contract_address)));',
  'create index if not exists idx_proxy_overrides_controller_canonical on proxy_overrides ((lower(controller_address)));',
];

const CREATE_AUDIT_LOG_TABLE_SQL = `
  create table if not exists audit_log (
    id text primary key,
    action text not null,
    target_address text not null,
    actor text not null,
    old_value jsonb,
    new_value jsonb,
    reason text not null,
    created_at timestamptz not null default now()
  );
`;

const CREATE_AUDIT_LOG_SUPPORTING_INDEXES_SQL = [
  'create index if not exists idx_audit_log_target_canonical on audit_log ((lower(target_address)));',
  'create index if not exists idx_audit_log_action on audit_log (action);',
  'create index if not exists idx_audit_log_created_at on audit_log (created_at);',
];

const CREATE_INGEST_QUARANTINE_TABLE_SQL = `
  create table if not exists ingest_quarantine (
    id text primary key,
    source text not null,
    raw_payload jsonb not null,
    failure_reason text not null,
    created_at timestamptz not null default now()
  );
`;

const CREATE_INGEST_QUARANTINE_SUPPORTING_INDEXES_SQL = [
  'create index if not exists idx_ingest_quarantine_source on ingest_quarantine (source);',
  'create index if not exists idx_ingest_quarantine_created_at on ingest_quarantine (created_at);',
];

export async function ensurePersistenceSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(CREATE_TRADE_OUTCOMES_TABLE_SQL);
  for (const statement of CREATE_TRADE_OUTCOMES_INDEXES_SQL) {
    await pool.query(statement);
  }
  await pool.query(FEED_SYNC_SCHEMA_SQL);
  await pool.query(X_CONTEXT_SCHEMA_SQL);
  for (const statement of KALSHI_SCHEMA_SQL) {
    await pool.query(statement);
  }
  await pool.query(CREATE_FILLS_TABLE_SQL);
  await pool.query(CREATE_FILLS_UNIQUE_INDEX_SQL);
  for (const statement of CREATE_FILLS_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_WALLETS_TABLE_SQL);
  await pool.query("alter table wallets add column if not exists activity_age_known boolean not null default true;");
  await pool.query('alter table wallets add column if not exists chain_profile jsonb;');
  await pool.query('alter table wallets add column if not exists chain_profiled_at timestamptz;');
  for (const statement of CREATE_WALLETS_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_FUNDING_EDGES_TABLE_SQL);
  for (const statement of CREATE_FUNDING_EDGES_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_SIGNAL_EVENTS_TABLE_SQL);
  for (const statement of CREATE_SIGNAL_EVENTS_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_ALERTS_TABLE_SQL);
  await pool.query('alter table alerts add column if not exists market_url text;');
  for (const statement of CREATE_ALERTS_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_ALERT_DELIVERIES_TABLE_SQL);
  for (const statement of CREATE_ALERT_DELIVERIES_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_WHALE_WHITELIST_TABLE_SQL);
  await pool.query("alter table whale_whitelist add column if not exists label text not null default '';");
  await pool.query("alter table whale_whitelist add column if not exists added_by text not null default 'manual';");
  for (const statement of CREATE_WHALE_WHITELIST_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_PROXY_OVERRIDES_TABLE_SQL);
  for (const statement of CREATE_PROXY_OVERRIDES_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_AUDIT_LOG_TABLE_SQL);
  for (const statement of CREATE_AUDIT_LOG_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }

  await pool.query(CREATE_INGEST_QUARANTINE_TABLE_SQL);
  await pool.query('alter table ingest_quarantine add column if not exists source text;');
  await pool.query('alter table ingest_quarantine add column if not exists raw_payload jsonb;');
  await pool.query("update ingest_quarantine set raw_payload = '{}'::jsonb where raw_payload is null;");
  await pool.query('alter table ingest_quarantine alter column raw_payload set not null;');
  await pool.query('alter table ingest_quarantine add column if not exists error_reason text;');
  await pool.query('alter table ingest_quarantine add column if not exists failure_reason text;');
  await pool.query(
    "update ingest_quarantine set failure_reason = coalesce(failure_reason, error_reason, 'unknown') where failure_reason is null;",
  );
  await pool.query('alter table ingest_quarantine alter column failure_reason set not null;');
  await pool.query(
    'update ingest_quarantine set error_reason = failure_reason where error_reason is null;',
  );
  await pool.query('alter table ingest_quarantine alter column error_reason set not null;');
  await pool.query('alter table ingest_quarantine add column if not exists created_at timestamptz;');
  await pool.query('update ingest_quarantine set created_at = now() where created_at is null;');
  await pool.query('alter table ingest_quarantine alter column created_at set default now();');
  await pool.query('alter table ingest_quarantine alter column created_at set not null;');
  for (const statement of CREATE_INGEST_QUARANTINE_SUPPORTING_INDEXES_SQL) {
    await pool.query(statement);
  }
}
