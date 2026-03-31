# OMEN — Prediction Market Insider Detection System

## Technical Specification · v1.8

> Full revision history at [end of document](#changelog).

---

## 1. Vision & Product Summary

Omen is a real-time prediction market **market-integrity intelligence** system that
detects insider trading patterns, tracks suspicious wallets, and scores market integrity.
It serves two audiences simultaneously:

1. **Personal alpha tool** — continuous monitoring with tiered Telegram/Discord alerts,
   operated via a terminal dashboard (TUI)
2. **ACP service agent** — on-demand insider detection sold to other agents and users on
   the Virtuals Protocol Agent Commerce Protocol for USDC revenue

The system is framed as **surveillance and research tooling**, not as a copy-trade or
front-running tool. Monetization is via intelligence services, not trade execution.

The MVP focuses exclusively on **Polymarket** (Polygon chain). Kalshi cross-platform
correlation is slated for v1.1. Token launch insider detection (Solana/Base) becomes a
module in v2.

**Repository**: `omen-bot`

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            OMEN SYSTEM                                  │
│                                                                         │
│  ┌─── MAIN THREAD (latency-sensitive I/O) ─────────────────────────┐   │
│  │  ┌────────────────────────────────────────────────────────┐      │   │
│  │  │ INGESTION: Polymarket CLOB (REST primary, WS upgrade) │      │   │
│  │  │            Polygon RPC (wallet age, tx count)          │      │   │
│  │  └────────────────────┬───────────────────────────────────┘      │   │
│  │                       │ persist fill → MessagePort to hot worker │   │
│  │  ┌────────────────────┴───────────────────────────────────┐      │   │
│  │  │ PRESENTATION: TUI (Ink 5) │ Alerts │ ACP Seller        │      │   │
│  │  └────────────────────────────────────────────────────────┘      │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── HOT PATH WORKER (real-time scoring, <2s/trade) ──────────────┐   │
│  │  Bounded queue (max 100). LIVE-stage signals only.               │   │
│  │  Wallet profiler (cached/lightweight) → Anomaly detector → Alert │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── COLD PATH (BullMQ, separate process, durable) ──────────────┐   │
│  │  Funding graph builder │ Cluster analysis │ Deep profile build   │   │
│  │  Resolution updater (edge calc + re-score) │ Snapshot creator    │   │
│  │  Cross-market correlator │ Retention cleanup │ Backfill (Dune)   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── PERSISTENCE ──────────────────────────────────────────────────┐   │
│  │  PostgreSQL 16: fills (immutable ledger), wallet profiles,       │   │
│  │    snapshots, signal events, markets, clusters, alerts,          │   │
│  │    subscriptions, funding edges, ingest checkpoints              │   │
│  │  Redis 7: wallet cache, dedup cooldowns, rate limits, BullMQ     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Hot Path / Cold Path Split

**Main thread** — latency-sensitive I/O only: trade ingestion, TUI rendering, alert
dispatch, ACP seller runtime. Persists raw fills to the immutable `fills` table, then
posts trade events to the hot path worker. No BullMQ job consumers on this thread.

**Hot path worker** (`worker_threads`) — real-time scoring, target <2s per trade.
Bounded MessagePort queue (max depth 100; if full, oldest dropped — next scan catches
up). Runs only `LIVE`-stage signals against cached/lightweight profiles. Returns alert
candidates to main thread.

**Cold path** (BullMQ workers in a separate process) — durable background work, no
latency constraint. Funding graphs, cluster analysis, cross-market correlation,
resolution updates, deep profiles, snapshots, cleanup. Results written to Postgres;
hot path reads updated data on next trade.

### 2.2 Async Backbone Responsibilities

| Mechanism     | Responsibility                          | NOT used for                        |
| ------------- | --------------------------------------- | ----------------------------------- |
| MessagePort   | Hot-path handoff: main ↔ hot worker     | Background jobs, persistence        |
| BullMQ        | Durable cold-path jobs only             | Real-time trade scoring             |
| Redis pub/sub | TUI streaming, external alert fanout    | Internal event bus, business logic   |

### 2.3 Database Connection Isolation

```
Main thread:       max 5 connections  (fill writes, TUI reads, alerts)
Hot path worker:   max 5 connections  (profile reads, lightweight queries)
Cold path workers: max 10 connections (deep reads: profiles, positions, graphs)
```

### 2.4 Worker Heartbeat & Restart

Hot path worker sends `HEARTBEAT` every 5s. Main thread kills and restarts if missing
>15s. Restart counter with backoff: 3 deaths within 5 minutes → halt and alert operator.

> **Known limitation**: `worker_threads` share the process. If the hot worker triggers
> a V8 fatal error or OOM, it takes the main thread down with it. The heartbeat handles
> normal crashes but not process-level kills. Acceptable for v1; a separate process
> architecture can be evaluated if this causes real-world pain.

### 2.5 Ingest Durability & Replay

Every raw fill is persisted to the immutable `fills` table *before* dispatch for
analysis. On restart:

1. Read last fill timestamp from `fills` (the checkpoint)
2. Request trades from Polymarket CLOB starting from that timestamp
3. Deduplicate via `(tx_hash, token_id)` unique constraint
4. Replay fills marked `analyzed = false`

Guarantees: no fill lost, no fill double-analyzed, clean crash recovery.

**Exactly-once analysis**: Signal persistence and alert dispatch must be idempotent.

*LIVE signals* (hot path): If the worker crashes after persisting a signal event but
before marking the fill as `analyzed = true`, replay will re-process that fill. The
`signal_events` table uses `unique(fill_id, signal_id)` to prevent duplicates.

*POST_RESOLUTION signals* (cold path): These are triggered by market resolution, not
by a single fill. Their idempotency key is `unique(wallet_address, market_id, signal_id)`
scoped to the resolution event. The resolution-updater job is itself idempotent — re-running
it for an already-resolved market produces the same results.

Alert dispatch checks dedup before sending. A crash at any point in either pipeline
produces at most one alert, never zero and never two.

### 2.6 Ingestion Mode

REST polling is **primary**. The Polymarket CLOB API is undocumented and has broken
before without notice. WebSocket is an **upgrade** for lower latency, with automatic
fallback to REST (15s interval) on disconnect. The system must function correctly in
REST-only mode.

### 2.7 Input Sanitization

All external text is treated as hostile. Per-surface sanitizers:

- **TUI**: strip ANSI escapes and control characters
- **Telegram**: escape HTML/Markdown injection
- **Discord**: escape Markdown, disable `@everyone`/`@here`
- **Logs**: pino safe serializers, max field length 1024
- **ACP**: sanitized through external DTO layer (§8.4)

### 2.8 Graceful Shutdown

Shutdown ordering matters with multiple runtimes and connections:

1. Stop accepting new trades (close WS, stop REST polling)
2. Drain hot worker MessagePort queue (finish in-flight analyses)
3. Wait for in-flight BullMQ jobs to complete (configurable timeout: 30s)
4. Flush buffered alerts (dispatch any pending Telegram/Discord)
5. Close ACP seller runtime
6. Close database connection pools (main, hot worker, cold workers)
7. Close Redis connections
8. Exit

Without explicit ordering: partial writes, orphaned BullMQ jobs, and unsent alerts
on restart.

### 2.9 Operational Notes

**Autovacuum**: The `fills` table is high-volume append-only with `analyzed` flag
flips generating dead tuples. Default PostgreSQL autovacuum settings will lag. Set
aggressive autovacuum parameters on `fills` from day one:

```sql
ALTER TABLE fills SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_delay = 5
);
```

**Alchemy rate limits**: Free tier is 330 CU/s. `getAssetTransfers` costs ~10 CU.
At scale, funding graph builds will bottleneck. Circuit breaker handles this gracefully
(graphs stop building, hot path continues with cached data). If sustained throughput
is needed, upgrade to paid tier or add fallback RPC.

---

## 3. Tech Stack

### Runtime & Language

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Language          | TypeScript 5.x (strict) | Primary language, ACP SDK compat, strong typing     |
| Runtime           | Node.js 22 LTS         | Worker threads, stable WS, mature ecosystem         |
| Package manager   | pnpm                    | Fast, strict, good workspace support                |
| Module system     | ESM                     | Modern standard, top-level await                    |

### Data & Persistence

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Primary DB        | PostgreSQL 16           | Relational queries, `numeric` for money, JSONB flex |
| ORM               | Drizzle ORM             | Type-safe, SQL-like, lightweight, great migrations  |
| Cache / Pub-Sub   | Redis 7 (ioredis)       | Alert fanout, wallet cache, rate limits, dedup      |
| Queue             | BullMQ                  | Durable cold-path jobs                              |

### Data Sources

| Source             | Protocol          | Purpose                                           |
| ------------------ | ----------------- | ------------------------------------------------- |
| Polymarket CLOB    | REST (primary)    | Markets, trades, orderbook, positions              |
| Polymarket CLOB    | WebSocket (opt)   | Low-latency trade stream (upgrade, not required)   |
| Alchemy Transfers  | REST (indexed)    | USDC + ETH funding traces via `getAssetTransfers`  |
| Polygon RPC        | JSON-RPC          | Wallet age, tx count, contract detection           |
| Polymarket Gamma   | REST              | Market metadata, categories, resolution            |
| Dune Analytics     | REST              | Historical backfill, bootstrap                     |

> **Funding trace scope**: Traces USDC *and* ETH/MATIC transfers. Insiders may fund via
> ETH, swap to USDC on-chain, then bet. The swap shows up in Polygon tx history.

### TUI

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Framework         | Ink 5 + ink-ui          | Actively maintained, React model, portability      |
| Theme tokens      | Tailwind hex values     | 1:1 translation to web dashboard in v2             |

### ACP Integration

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| SDK               | openclaw-acp            | Official Virtuals ACP CLI/SDK                      |
| Seller runtime    | ACP WebSocket seller    | Incoming job listener                               |

### Quality & Tooling

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Linting           | Biome                   | Fast unified lint + format                          |
| Testing           | Vitest + fast-check     | TS-native, property-based tests for stats           |
| Schema validation | Zod                     | Runtime validation of API responses, config         |
| Logging           | pino                    | Structured JSON, low overhead                       |
| Env / Secrets     | direnv + dotenv (dev)   | Prod: KMS/Keychain for ACP keys and bot tokens      |
| Git hooks         | lefthook                | Pre-commit: lint, typecheck, test                   |

---

## 4. Project Structure

```
omen-bot/
├── src/
│   ├── index.ts                        # Main thread entry
│   ├── hot-worker.ts                   # Hot path worker entry
│   ├── cold-worker.ts                  # Cold path BullMQ worker entry
│   │
│   ├── config/
│   │   ├── index.ts                    # Config loader
│   │   ├── schema.ts                   # Zod schemas
│   │   └── constants.ts                # Thresholds, weights
│   │
│   ├── ingestion/
│   │   ├── polymarket-client.ts        # REST client
│   │   ├── polymarket-ws.ts           # WS trade stream (optional upgrade)
│   │   ├── polygon-rpc.ts             # Wallet age, tx count, contract detection
│   │   ├── alchemy-transfers.ts       # USDC + ETH funding traces
│   │   ├── gamma-client.ts            # Market metadata, resolution
│   │   ├── dune-client.ts             # Historical backfill
│   │   └── types.ts
│   │
│   ├── analysis/
│   │   ├── wallet-profiler.ts          # Build/update profiles
│   │   ├── anomaly-detector.ts         # Signal evaluation + composite scoring
│   │   ├── cluster-engine.ts           # Sybil detection, funding graph
│   │   ├── statistical.ts             # T-test on edge, win-rate analysis
│   │   ├── cross-market-correlator.ts  # Common info source detection
│   │   ├── social-check.ts            # Timing burst FP suppression
│   │   ├── proxy-detector.ts          # Detect contract wallets, trace controllers
│   │   ├── scoring-weights.ts          # Signal weights, thresholds
│   │   └── types.ts
│   │
│   ├── persistence/
│   │   ├── db.ts                       # Drizzle client
│   │   ├── schema.ts                   # All table definitions
│   │   ├── migrations/
│   │   ├── redis.ts
│   │   ├── cache.ts
│   │   └── queries/
│   │       ├── fills.ts                # Immutable fill ledger
│   │       ├── wallets.ts              # Profiles + snapshots
│   │       ├── markets.ts
│   │       ├── alerts.ts
│   │       ├── signal-events.ts        # Normalized signal history
│   │       ├── clusters.ts
│   │       ├── subscriptions.ts        # Watchlist state machine
│   │       ├── audit-log.ts            # Proxy/whitelist override history
│   │       ├── quarantine.ts           # Malformed ingest payload review
│   │       └── funding-graph.ts
│   │
│   ├── engine/
│   │   ├── index.ts
│   │   ├── market-scanner.ts
│   │   ├── fill-processor.ts           # Persist fill → dispatch to hot worker
│   │   ├── resolution-tracker.ts
│   │   └── thread-bridge.ts            # MessagePort protocol
│   │
│   ├── jobs/                           # Cold path BullMQ jobs
│   │   ├── queue.ts
│   │   ├── funding-graph-builder.ts
│   │   ├── cluster-analyzer.ts
│   │   ├── deep-profile-builder.ts
│   │   ├── resolution-updater.ts
│   │   ├── snapshot-creator.ts
│   │   ├── retention-cleanup.ts        # Fills, snapshots, funding edges
│   │   └── backfill.ts
│   │
│   ├── resilience/
│   │   ├── circuit-breaker.ts
│   │   ├── retry.ts
│   │   ├── rate-limiter.ts
│   │   ├── dedup.ts                    # Scoped: market:wallet:signal
│   │   ├── backpressure.ts             # Bounded queue for hot worker
│   │   ├── sanitizer.ts               # Per-surface input sanitization
│   │   └── health.ts
│   │
│   ├── alerts/
│   │   ├── dispatcher.ts
│   │   ├── telegram.ts
│   │   ├── discord.ts
│   │   ├── formatter.ts
│   │   └── types.ts
│   │
│   ├── acp/
│   │   ├── offerings/
│   │   │   ├── offering.json
│   │   │   └── handlers.ts
│   │   ├── server.ts
│   │   ├── dto.ts                      # External DTOs (never serialize DB entities)
│   │   └── rate-guard.ts               # Per-buyer quotas, job coalescing
│   │
│   ├── tui/
│   │   ├── app.tsx                     # Root Ink component
│   │   ├── components/
│   │   │   ├── alert-feed.tsx          # Phase 1: primary panel
│   │   │   ├── status-bar.tsx          # Phase 1: connection state + counts
│   │   │   ├── market-scanner.tsx      # Phase 2: market table
│   │   │   ├── wallet-inspector.tsx    # Phase 2: detail view
│   │   │   ├── cluster-map.tsx         # Phase 2: progressive disclosure graph
│   │   │   └── help-overlay.tsx
│   │   ├── hooks/
│   │   │   ├── use-alerts.ts
│   │   │   ├── use-markets.ts
│   │   │   └── use-keyboard.ts
│   │   └── theme.ts                    # Tailwind hex tokens, tier color discipline
│   │
│   └── types/
│       ├── wallet.ts
│       ├── market.ts
│       ├── signal.ts
│       ├── alert.ts
│       ├── thread-messages.ts
│       └── common.ts
│
├── tests/
│   ├── unit/analysis/
│   ├── unit/engine/
│   ├── unit/resilience/
│   ├── integration/
│   └── fixtures/
│       └── insider-cases/              # Labeled: Venezuela, KPMG, Axiom,
│                                       #   France election, Trump cabinet
├── scripts/
│   ├── backtest.ts
│   ├── seed-db.ts
│   ├── calibrate-weights.ts
│   └── bootstrap-from-dune.ts
│
├── drizzle.config.ts
├── vitest.config.ts
├── biome.json
├── tsconfig.json
├── package.json
├── .env.example
├── .envrc
├── omen.config.toml                    # Tuning parameters (versionable)
├── docker-compose.yml
└── README.md
```

### 4.1 CLI Commands

All key operations are accessible via the `omen` CLI:

```bash
# Core operations
omen start                  # Supervises all processes: main thread + hot worker +
                            #   spawns cold-worker process. TUI renders in foreground.
omen start --headless       # Same supervision, no TUI (daemon mode)
omen start --dry-run        # Full analysis, suppress alert dispatch + ACP
omen start --no-acp         # Start without ACP seller runtime

# Inspection (one-shot, no long-running process)
omen scan <marketId>        # One-shot market insider scan (prints to stdout)
omen profile <address>      # One-shot wallet suspicion score
omen cluster <address>      # One-shot cluster analysis
omen health                 # Print system health status

# Data management
omen validate-fills         # Phase 0: run fill dedup verification against live CLOB data
omen backfill               # Bootstrap historical data from Dune
omen replay                 # Replay unanalyzed fills from checkpoint
omen cleanup                # Run retention cleanup (fills, snapshots, funding edges)

# Configuration
omen config show            # Print resolved config (TOML + env overrides).
                            #   REDACTS all secrets (DB creds, API keys, bot tokens).
omen config validate        # Validate config against Zod schema

# ACP (Phase 3+)
omen acp start              # Start ACP seller runtime STANDALONE (without detector).
                            #   Use when running ACP separately from `omen start`.
                            #   Do NOT run alongside `omen start` (unless --no-acp) —
                            #   duplicate seller runtimes will create double-dispatch bugs.
omen acp status             # Show ACP agent status, active jobs, subscriptions
```

> Implementation: entry points in `src/index.ts` (start), `src/cli.ts` (one-shot commands),
> `src/cold-worker.ts` (background jobs). CLI framework: `citty` or plain `process.argv`
> parsing — keep it minimal.

---

## 5. Domain Types

### 5.1 Wallet Profile

```typescript
// src/types/wallet.ts

export type Address = `0x${string}`;

export interface WalletProfile {
  address: Address;

  // Identity
  ageSeconds: number;
  totalTransactions: number;
  isContract: boolean;             // True = proxy/Safe multisig, not EOA
  controllerAddress: Address | null; // If contract: deployer/controller EOA
  firstSeenAt: Date;
  lastActiveAt: Date;

  // Polymarket Activity
  totalMarkets: number;
  totalFills: number;              // Immutable fill count (source of truth)
  activeFillMarkets: number;       // Markets with open exposure
  totalVolumeUsd: string;          // numeric string (no float precision loss)

  // Performance — edge-adjusted model (computed from resolved fills)
  resolvedPositions: number;
  wins: number;
  losses: number;
  winRate: number;
  avgEdgeAtEntry: number;          // Mean (resolutionValue - entryPrice) across ALL
                                   //   resolved positions including losers
  edgeTTestPValue: number;         // One-sample t-test: is mean edge > 0?
  totalPnlUsd: string;            // numeric string

  // Behavioral Signals
  categoryConcentration: number;   // 0-1 Herfindahl index
  topCategories: string[];
  avgEntryTimingMinutes: number;
  preResolutionRatio: number;
  avgPositionSizePct: number;
  lumpEntryRatio: number;
  convictionRatio: number;

  // Funding
  fundingSources: FundingSource[];
  fundingClusterId: string | null;
  fundingGraphBuiltAt: Date | null;

  // Scoring — dual scores
  liveSuspicionScore: number;      // 0-100, clamped. LIVE signals only.
  retrospectiveScore: number;      // 0-100, clamped. All signals incl POST_RESOLUTION.
  liveSignals: TriggeredSignal[];
  retrospectiveSignals: TriggeredSignal[];
  liveTier: AlertTier;
  retrospectiveTier: AlertTier;

  // Internal-only metadata (NEVER exposed via ACP DTOs)
  labels: string[];
  notes: string;
  isWhitelisted: boolean;          // Known market maker / legitimate whale
  createdAt: Date;
  updatedAt: Date;
}
```

### 5.2 Detection Signals

```typescript
// src/types/signal.ts

export type SignalAvailability = 'LIVE' | 'POST_RESOLUTION';

export enum SignalId {
  // Tier 1 — High confidence
  FRESH_WALLET_LARGE_POSITION    = 'FRESH_WALLET_LARGE_POSITION',
  PRE_RESOLUTION_TIMING          = 'PRE_RESOLUTION_TIMING',
  STATISTICAL_IMPROBABILITY      = 'STATISTICAL_IMPROBABILITY',
  SYBIL_CLUSTER                  = 'SYBIL_CLUSTER',

  // Tier 2 — Medium confidence
  CATEGORY_HYPERSPECIALIZATION   = 'CATEGORY_HYPERSPECIALIZATION',
  OUTSIZED_POSITION              = 'OUTSIZED_POSITION',
  LUMP_ENTRY                     = 'LUMP_ENTRY',
  CROSS_MARKET_COMMON_SOURCE     = 'CROSS_MARKET_COMMON_SOURCE',
  CONVICTION_SIZE_MISMATCH       = 'CONVICTION_SIZE_MISMATCH',
  TIMING_CLUSTER_BURST           = 'TIMING_CLUSTER_BURST',

  // Tier 3 — Contextual
  CEX_FUNDING_BEFORE_BET         = 'CEX_FUNDING_BEFORE_BET',
  RAPID_POST_RESOLUTION_EXIT     = 'RAPID_POST_RESOLUTION_EXIT',
  MARKET_ORDER_ONLY              = 'MARKET_ORDER_ONLY',
  NICHE_MARKET_ENTRY             = 'NICHE_MARKET_ENTRY',
}

/** Signals that depend on future data MUST NOT fire in real-time alerts. */
export const SIGNAL_AVAILABILITY: Record<SignalId, SignalAvailability> = {
  FRESH_WALLET_LARGE_POSITION:   'LIVE',
  PRE_RESOLUTION_TIMING:         'POST_RESOLUTION',  // Needs resolvedAt
  STATISTICAL_IMPROBABILITY:     'POST_RESOLUTION',  // Needs resolved outcomes
  SYBIL_CLUSTER:                 'LIVE',             // Funding graph is pre-trade
  CATEGORY_HYPERSPECIALIZATION:  'POST_RESOLUTION',  // Needs win history
  OUTSIZED_POSITION:             'LIVE',
  LUMP_ENTRY:                    'LIVE',
  CROSS_MARKET_COMMON_SOURCE:    'POST_RESOLUTION',  // Needs resolved win pattern
  CONVICTION_SIZE_MISMATCH:      'LIVE',
  TIMING_CLUSTER_BURST:          'LIVE',
  CEX_FUNDING_BEFORE_BET:        'LIVE',
  RAPID_POST_RESOLUTION_EXIT:    'POST_RESOLUTION',
  MARKET_ORDER_ONLY:             'LIVE',
  NICHE_MARKET_ENTRY:            'LIVE',
};

export interface SignalDefinition {
  id: SignalId;
  tier: 1 | 2 | 3;
  availability: SignalAvailability;
  name: string;
  description: string;
  weight: number;
  evaluate: (ctx: SignalContext) => SignalResult;
}

export interface SignalContext {
  wallet: WalletProfile;
  fill?: Fill;
  market?: MarketInfo;
  cluster?: WalletCluster;
  recentMarketFills?: Fill[];
}

export interface SignalResult {
  triggered: boolean;
  score: number;       // 0-100
  confidence: number;  // 0-1
  evidence: SignalEvidence[];
}

export interface SignalEvidence {
  field: string;
  value: string | number;
  threshold: string | number;
  description: string;
}

export interface TriggeredSignal {
  signalId: SignalId;
  score: number;
  confidence: number;
  evidence: SignalEvidence[];
  triggeredAt: Date;
}

export type AlertTier = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAN';
```

### 5.3 Fill & Market Types

```typescript
// src/types/market.ts

export type MarketId = string;
export type TokenId = string;
export type ResolutionType = 'SCHEDULED' | 'UNSCHEDULED' | 'UNKNOWN';

export interface MarketInfo {
  id: MarketId;
  question: string;
  category: string;
  subcategory: string | null;
  endDate: Date;
  resolved: boolean;
  outcome: 'YES' | 'NO' | null;
  resolvedAt: Date | null;
  resolutionType: ResolutionType;
  volumeUsd: string;              // numeric string
  liquidityUsd: string;
  dailyVolumeUsd: string;
  uniqueTraders: number;
  informationSource: InformationSource | null;
  flaggedWalletCount: number;
  maxSuspicionScore: number;
  anomalyLevel: 'NONE' | 'LOW' | 'ELEVATED' | 'HIGH' | 'CRITICAL';
}

export interface InformationSource {
  type: InformationSourceType;
  entity: string;
  confidence: number;
}

export type InformationSourceType =
  | 'AUDITOR' | 'GOVERNMENT_AGENCY' | 'POLITICAL_BODY' | 'CORPORATE_INSIDER'
  | 'MILITARY_INTELLIGENCE' | 'SPORTS_ORGANIZATION' | 'CRYPTO_PROJECT'
  | 'MEDIA_ORGANIZATION' | 'UNKNOWN';

/** Immutable fill record — the source of truth. */
export interface Fill {
  id: string;                      // ulid
  marketId: MarketId;
  tokenId: TokenId;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  price: string;                   // numeric string 0.00-1.00
  shares: string;                  // numeric string
  sizeUsd: string;                 // numeric string
  maker: Address;
  timestamp: Date;
  txHash: string;
  orderType: 'TAKER' | 'MAKER' | 'UNKNOWN';
  analyzed: boolean;               // True = LIVE hot-path analysis complete.
                                   //   Does NOT mean cold-path work (cluster, deep profile,
                                   //   resolution scoring) is done. Only used for replay
                                   //   checkpoint: "has the hot worker seen this fill?"
}
```

### 5.4 Thread Message Protocol

```typescript
// src/types/thread-messages.ts

/** All requests carry requestId (ulid) for correlation. */

export type MainToWorkerMessage =
  | { type: 'ANALYZE_FILL'; requestId: string;
      payload: { fill: Fill; market: MarketInfo } }
  | { type: 'PROFILE_WALLET'; requestId: string;
      payload: { address: Address; forceRefresh: boolean } }
  | { type: 'SCAN_MARKET'; requestId: string;
      payload: { marketId: MarketId } };

export type WorkerToMainMessage =
  | { type: 'HEARTBEAT' }
  | { type: 'ALERT'; payload: { alert: Alert } }
  | { type: 'PROFILE_RESULT'; requestId: string;
      payload: { profile: WalletProfile } }
  | { type: 'MARKET_SCAN_RESULT'; requestId: string;
      payload: { marketId: MarketId; flaggedWallets: WalletProfile[] } }
  | { type: 'ERROR'; requestId: string;
      payload: { requestType: string; error: string } };
```

> Note: `ANALYZE_FILL` is fire-and-forget — if a signal triggers, the worker emits an
> unsolicited `ALERT`. The main thread does not wait for a correlated response. This is
> intentional: trade analysis is high-volume, low-latency work.
>
> Implementation note: the hot worker must profile the wallet (query Polygon for real
> age/tx count) *before* running signals. If it evaluates against the stub data
> (ageSeconds: 0), `FRESH_WALLET_LARGE_POSITION` fires on every new wallet's first fill.

---

## 6. Detection Engine

### 6.1 Dual Scoring Model

Signals are classified by availability stage:

- **LIVE signals** fire in real-time on incoming fills (hot path). They produce
  `liveSuspicionScore` and drive real-time alerts.
- **POST_RESOLUTION signals** fire retroactively after markets resolve (cold path
  resolution-updater job). They produce `retrospectiveScore` and drive retrospective
  analysis.

The TUI and alerts clearly label which score is being shown. `liveSuspicionScore` is
never inflated by post-resolution data — this prevents look-ahead bias.

**Composite score clamping**: Both scores are clamped to [0, 100] in the scoring
function, not by convention. The additive model with 14 signals could theoretically
exceed 100 without explicit clamping.

**Whale whitelist exclusion**: Wallets in the `whale_whitelist` table (known market
makers, >$500K lifetime volume + >100 markets) are excluded from signal evaluation
entirely. Without this, alert feeds drown in noise from legitimate whales.

**Proxy wallet detection**: Before evaluating `FRESH_WALLET_LARGE_POSITION`, check if
the address is a contract (proxy/Safe multisig). If so, trace the deployer/controller
wallet and use *its* age. A newly-deployed proxy controlled by a 2-year-old EOA is not
a fresh wallet.

### 6.2 Scoring Weights

```typescript
export const SIGNAL_WEIGHTS: Record<SignalId, number> = {
  // Tier 1 (max 30pts each)
  FRESH_WALLET_LARGE_POSITION:    30,
  PRE_RESOLUTION_TIMING:          25,
  STATISTICAL_IMPROBABILITY:      30,
  SYBIL_CLUSTER:                  25,
  // Tier 2 (max 15pts each)
  CATEGORY_HYPERSPECIALIZATION:   10,
  OUTSIZED_POSITION:              12,
  LUMP_ENTRY:                     8,
  CROSS_MARKET_COMMON_SOURCE:     15,
  CONVICTION_SIZE_MISMATCH:       14,
  TIMING_CLUSTER_BURST:           13,
  // Tier 3 (max 8pts each)
  CEX_FUNDING_BEFORE_BET:         8,
  RAPID_POST_RESOLUTION_EXIT:     5,
  MARKET_ORDER_ONLY:              5,
  NICHE_MARKET_ENTRY:             7,
};

export const TIER_THRESHOLDS: Record<AlertTier, number> = {
  CRITICAL: 80, HIGH: 60, MEDIUM: 40, LOW: 20, CLEAN: 0,
};
```

### 6.3 Key Signal Implementations

**FRESH_WALLET_LARGE_POSITION** — Two-tier wallet age threshold reflecting documented
insider behavior:

- `walletAgeScore < 24 hours => 1.0` (maximum suspicion)
- `walletAgeScore 24-72 hours => 0.6` (elevated)
- `walletAgeScore > 72 hours => signal does not fire`

Trigger shape:

```text
IF walletAgeScore > 0
   AND wallet.totalTransactions < 10
   AND trade.sizeUsd > max(market.dailyVolumeUsd * 0.02, $1000)
   AND market.dailyVolumeUsd < $100,000
THEN score = walletAgeScore * f(positionSize, marketLiquidity) * weight
```

Proxy refinement: if `wallet.isContract`, trace the deployer/controller wallet and use
its age instead. A newly-deployed proxy controlled by a 2-year-old EOA is not a fresh
wallet. Default conservative behavior: if controller attribution is unavailable, do not
fire this signal.

**OUTSIZED_POSITION** — Market-relative single-fill anomaly. This is “large for this
market,” not merely “large in absolute dollars.”

```text
IF trade.sizeUsd > max(market.dailyVolumeUsd * 0.02, $1000)
THEN score = f(exceedanceOverThreshold, marketLiquidity) * weight
```

No freshness precondition and no niche-market cap. This signal is meant to light up
abnormally large entries even when the wallet is old, proxied, or otherwise unremarkable.

**STATISTICAL_IMPROBABILITY** — One-sample t-test on edge distribution (all resolved
positions, winners + losers).

For each resolved position `i`:

```text
entryPrice_i  = price paid
resolution_i  = 1.0 if position's side won, 0.0 if lost
edge_i        = resolution_i - entryPrice_i
```

Examples:

- Bought YES at `$0.30`, resolved YES → `edge = +0.70`
- Bought YES at `$0.85`, resolved YES → `edge = +0.15`
- Bought YES at `$0.60`, resolved NO  → `edge = -0.60`

Under the null hypothesis (`E[edge] = 0` for non-informational entries), use a
**one-sample** t-test against `μ = 0`, one-tailed for positive edge:

```text
t = mean(edges) / (stdev(edges) / sqrt(n))
pValue = 1 - cdf_t(t, df = n - 1)
```

Trigger shape:

```text
IF pValue < 0.001
   AND resolvedPositions >= 8
   AND avgEdgeAtEntry > 0.15
THEN score = min(100, -log10(pValue) * 12 + avgEdgeAtEntry * 30)
```

Including losers is critical: a wallet with a few spectacular wins but many mediocre
losses has a very different profile from one with the same wins and no losses. Normality
caveat remains documented; Wilcoxon signed-rank is the v2 fallback.

> **Market difficulty normalization (experimental)**: Raw edge doesn't account for market
> difficulty. Winning 8/8 on 90/10 markets ≠ winning 8/8 on 50/50 markets. Normalization:
> `normalizedEdge_i = edge_i / sqrt(entryPrice * (1 - entryPrice))`
> This penalizes easy wins and amplifies hard wins. **Implementation**: compute raw AND
> normalized edge in parallel. Track both `avgEdgeAtEntry` and `avgNormalizedEdge` on the
> profile. Run the t-test on raw edge for v1 alerts. Let Phase 2 backtests prove which
> predicts better before switching. Tag with `scoringVersion` so the two models can be
> compared cleanly. Don't let this become a stats sidequest.

**PRE_RESOLUTION_TIMING** — Availability: `POST_RESOLUTION` only. Timing is
resolution-type aware:

- `SCHEDULED`: suspicious `< 10m`, elevated `< 30m`
- `UNSCHEDULED`: suspicious `< 60m`, elevated `< 360m`
- `UNKNOWN`: use unscheduled thresholds conservatively

```text
entryMinutesBefore = (market.resolvedAt - trade.timestamp) in minutes

IF entryMinutesBefore < suspiciousWindow
THEN score = 1.0 * weight
ELSE IF entryMinutesBefore < elevatedWindow
THEN score = 0.5 * weight
ELSE signal does not fire
```

Never fires in real-time; it would require knowing the future.

**SYBIL_CLUSTER** — Cache-first, fan-out limited.

1. Check Postgres `funding_graph` cache for the target wallet.
2. If fresh (`< 24h old`), use cached data; if stale/missing, enqueue a rebuild and use
   whatever cache exists.
3. Apply graph limits: top `5` funding sources per hop, max depth `4`, hard ceiling
   `200 RPC calls` per build.
4. Apply temporal correlation: did cluster members enter the same market within `1h`?
5. Apply behavioral similarity: same categories and sides?

```text
IF cluster.size >= 3
   AND fundingOverlap.commonAncestors.length >= 1
   AND temporalCorrelation.sameMarketEntries >= 2
THEN score = f(clusterSize, fundingDepth, temporalTightness) * weight
```

**CONVICTION_SIZE_MISMATCH** — Small, inexperienced wallets betting the farm on a
longshot.

Preconditions:

- `wallet.fundingClusterId === null`
- `wallet.isWhitelisted === false`

```text
IF wallet.totalVolumeUsd < $5,000
   AND trade.sizeUsd > wallet.totalVolumeUsd * 0.50
   AND trade.price < 0.30
THEN score = f(sizeRatio, priceLevel, accountAge) * weight
```

**TIMING_CLUSTER_BURST** — Tight same-side bursts from unrelated wallets on niche
markets.

```text
IF distinctWallets >= 5
   AND market.dailyVolumeUsd < $100,000
   AND allSameSide == true
   AND noSharedFundingSources == true
THEN score = f(walletCount, timeWindow, marketLiquidity) * weight
```

False-positive mitigation: run a bounded social-correlation suppression check only when
the signal fires. Major mentions in Google News or the curated Twitter/X account set
within the lookback window halve the score.

**CROSS_MARKET_COMMON_SOURCE** — The KPMG detector.

1. Classify `informationSource` for all markets (manual for high-value categories,
   LLM-assisted for new markets).
2. Group a wallet’s wins by `informationSource`.
3. Compute `concentration = max(winsPerSource) / totalWins`.

```text
IF concentration > 0.6
   AND totalWins >= 3
   AND informationSource.type != 'UNKNOWN'
THEN score = f(concentration, totalWins, entityType) * weight
```

> **Future signal candidate: POSITION_FLIP** — Insider buys YES at $0.20, market
> moves to $0.85, insider flips to NO before resolution, profits on both legs. The
> fills ledger captures this pattern (net position reversal + outsized fills on both
> sides of same market). Not in v1 signal matrix but detectable from existing data.
> Evaluate after Phase 2 backtest results.

### 6.4 Engine Operational Patterns

**Wallet stub upsert**: On first fill encounter, trade processor upserts minimal stub
(address, firstSeenAt, lastActiveAt; all analysis fields use DB defaults). Hot worker
*must* query Polygon for real age/tx count before scoring.

**edgeAtEntry computation** (resolution-updater cold path job):
1. Fetch all fills for resolved market
2. Aggregate into position lots per wallet
3. Compute `edgeAtEntry = (won ? 1.0 : 0.0) - avgEntryPrice`
4. Recompute wallet profile: wins, losses, avgEdgeAtEntry, edgeTTestPValue
5. Re-run anomaly detector (POST_RESOLUTION signals now computable)
6. Snapshot wallet if score changed by >5 points

**Orderbook cold-start**: Known v1 limitation. Trades before first WS snapshot get
`orderType: 'UNKNOWN'`. Acceptable: MARKET_ORDER_ONLY is Tier 3 / 5pts.

---

## 7. Resilience

### 7.1 Circuit Breakers

Per-service: Polymarket API, Polygon RPC, Alchemy API, Telegram, Discord.
Fallback: WS dies → REST polling. Alchemy rate-limited → skip funding traces.

### 7.2 Alert Deduplication

Scope: `omen:dedup:{marketId}:{walletAddress}:{signalId}` (market-scoped, not global).
This prevents suppressing a legitimate alert on a *different* market. 24h cooldown, with
re-alert if score increases by >10 points. `recordAlert()` writes after dispatch.

### 7.3 Backpressure

Hot path worker MessagePort has a bounded queue (max depth 100, configurable). If full,
oldest unprocessed fill is dropped. This is acceptable because:
- The next market scan cycle (15s) will re-evaluate the market
- Critical wallets are profiled and cached, so they're caught on next fill

### 7.4 Health Checks

Status includes: postgres, redis, polymarket WS/REST, alchemy, hot worker (heartbeat),
cold workers (BullMQ job stats), uptime, last fill processed, tracked markets/wallets.

---

## 8. ACP Integration

### 8.1 Offering Manifest

```json
{
  "market_insider_scan": {
    "description": "Scan a Polymarket market for insider signals.",
    "price": "50.00",
    "currency": "USDC",
    "depthTiers": {
      "quick":    "Cached data only. ~5s.",
      "standard": "Refresh 24h profiles, cached graph, LIVE signals. ~30-60s.",
      "deep":     "Force-refresh all. Full signal matrix. ~2-5min."
    },
    "note": "Intelligence value scales with market stakes. A $50 scan that catches a real insider in a $500K market is a 10,000x ROI for the buyer."
  },
  "wallet_suspicion_score": {
    "description": "Composite insider score for a Polymarket wallet.",
    "price": "25.00",
    "currency": "USDC",
    "estimatedDelivery": "30s",
    "note": "Returns cached profile if fresh. Deep funding trace async."
  },
  "cluster_analysis": {
    "description": "Map Sybil cluster for a wallet.",
    "price": "75.00",
    "currency": "USDC",
    "estimatedDelivery": "120s"
  },
  "market_watchlist": {
    "description": "Subscribe to continuous insider monitoring for a market.",
    "currency": "USDC",
    "pricing": "Tiered: $50 (<$100K vol), $100 ($100K-$1M), $200 (>$1M). Max 30 days.",
    "note": "Subscription. Alerts via ACP memo updates. Final report on resolution/expiry."
  }
}
```

### 8.2 ACP Job Handler

Handler validates inputs before accepting payment. Watchlist validates market exists
and is unresolved. All responses go through external DTO layer (§8.4).

### 8.3 Watchlist Subscription Lifecycle

Persisted in `subscriptions` table as a state machine:

```
ACP FUNDED     → Subscription created (ACTIVE), market added to watchlist
ACP IN_PROGRESS → Monitoring. Interim alerts via ACP memo messages.
ACP COMPLETED  → Final report delivered. Triggers:
                  (a) Market resolves → comprehensive retroactive report
                  (b) 30-day timeout → summary of all activity to date
                  (c) Consumer cancellation → partial results, no refund
ACP EXPIRED    → Subscription cleaned up
```

Final report includes: monitoring duration, fills scanned, wallets analyzed, all
signals fired with evidence, retroactive accuracy, or explicit "no anomalies" statement.
"Market was clean" is a valid successful delivery.

### 8.4 Tenant Boundary & External DTOs

**Never serialize DB entities directly to ACP responses.** Create explicit external DTOs
in `src/acp/dto.ts` that:

- Exclude internal-only fields: `labels`, `notes`, `isWhitelisted`, `fundingSources`
  raw data, internal cluster IDs
- Sanitize all text fields via `sanitizer.ts`
- Scope all artifacts to the requesting `customerId`/`jobId`

### 8.5 Griefing Protection

- **Per-buyer quotas**: max 10 concurrent jobs, max 3 deep scans per hour
- **Job coalescing**: identical `market_insider_scan` requests within 60s return cached
  result instead of re-running analysis
- **Load shedding**: when system is under heavy load, `deep` scans fall back to
  `standard` with a note in the response
- **Watchlist cap**: max 50 active subscriptions total, max 5 per buyer

---

## 9. TUI Design

### 9.1 Phase 1 Layout (MVP — 2 panels)

```
┌─ OMEN v1.0 ─────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌─ 🔴 LIVE ALERTS ────────────────────────────────────────────────────┐│
│  │ ▸ CRITICAL 12:34:05                                                 ││
│  │   0x7a3…f91 → $15K YES on "Will X resign?"                         ││
│  │   Age: 2h │ Txns: 3 │ Edge: 0.72 │ Live score: 92                  ││
│  │   ● FRESH_WALLET_LARGE_POS [30] ● CONVICTION_MISMATCH [14]         ││
│  │   ● NICHE_MARKET [7]                                                ││
│  │                                                                     ││
│  │ ▸ HIGH 12:31:22                                                     ││
│  │   Cluster [5 wallets] → $50K into "Axiom insider?" mkt             ││
│  │                                                                     ││
│  │ ▸ MEDIUM 12:28:10                                                   ││
│  │   0xabc…123 │ Retrospective p<0.0001 │ Avg edge: 0.58              ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│  ● REST ● WS │ Mkts: 1,247 │ Wallets: 3,891 │ Alerts: 47 │ Hot ▲     │
│  [q]Quit [?]Help [t]TierFilter [d]DryRun [Esc]Reset                   │
└─────────────────────────────────────────────────────────────────────────┘
```

Phase 1 ships with **Alert Feed + Status Bar only** (2 panels). This is fully functional
— alerts are where you act. Market scanner, wallet inspector, and cluster map are Phase 2
TUI additions.

### 9.2 Visual Hierarchy

Strict color discipline in `theme.ts` (Tailwind hex tokens for web portability):

- **CRITICAL**: Red text + inverted background tag. Demands eye contact.
- **HIGH**: Amber/yellow text.
- **MEDIUM**: Blue text.
- **LOW**: Dim gray. Recedes into background.
- **CLEAN**: Not rendered in alert feed.

If everything is bright, nothing is. Let high-signal alerts punch through the noise.

### 9.3 Keybinds

| Key    | Action                                      |
| ------ | ------------------------------------------- |
| `j`/`k`| Scroll alert feed                           |
| `t`    | Toggle alert tier filter                     |
| `d`    | Toggle dry-run mode                          |
| `Esc`  | Clear search/filter, reset focus to default  |
| `?`    | Help overlay                                 |
| `q`    | Quit                                         |

Phase 2 adds: `Tab` (focus cycle), `Enter` (inspect), `/` (search), `f` (filter
markets), `s` (sort), `n` (note), `l` (label), `e` (export).

### 9.4 Progressive Disclosure (Phase 2)

Cluster map: render top 5 nodes by volume. Large clusters show
`[+40 others... Press C to expand list]`. Never let a 45-wallet Sybil cluster break
the layout.

Empty/loading states: before trades flow, show `Listening to Polymarket...` with
connection indicators. Not a blank/broken screen.

---

## 10. Database Schema

> All money, price, share, and PnL fields use `numeric(...)` or `double precision`.
> `real` (single-precision float) is **never** used for financial data or score math.

```typescript
// src/persistence/schema.ts (Drizzle ORM)

import { pgTable, text, integer, numeric, doublePrecision, boolean,
         timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

// ═══════════════════════════════════════════════════════════════
// FILLS — Immutable source of truth. Never modified after insert.
// Positions/profiles are derived views computed from this ledger.
// ═══════════════════════════════════════════════════════════════

export const fills = pgTable('fills', {
  id:              text('id').primaryKey(),             // ulid
  marketId:        text('market_id').notNull(),
  tokenId:         text('token_id').notNull(),
  walletAddress:   text('wallet_address').notNull(),
  side:            text('side').notNull(),              // BUY | SELL
  outcome:         text('outcome').notNull(),            // YES | NO
  price:           numeric('price', { precision: 10, scale: 6 }).notNull(),
  shares:          numeric('shares', { precision: 20, scale: 6 }).notNull(),
  sizeUsd:         numeric('size_usd', { precision: 20, scale: 6 }).notNull(),
  txHash:          text('tx_hash').notNull(),
  orderType:       text('order_type'),                   // TAKER | MAKER | UNKNOWN
  timestamp:       timestamp('timestamp').notNull(),
  analyzed:        boolean('analyzed').default(false),    // LIVE hot-path analysis done
                   // NOT "all downstream cold-path work done". Replay checkpoint only.
  createdAt:       timestamp('created_at').defaultNow(),
}, (table) => [
  uniqueIndex('idx_fills_unique').on(table.txHash, table.tokenId),
  index('idx_fills_wallet').on(table.walletAddress),
  index('idx_fills_market').on(table.marketId),
  index('idx_fills_timestamp').on(table.timestamp),
  index('idx_fills_unanalyzed').on(table.analyzed).where('analyzed = false'),
]);

// ═══════════════════════════════════════════════════════════════
// WALLETS — Derived summary. Rebuilt from fills + external data.
// ═══════════════════════════════════════════════════════════════

export const wallets = pgTable('wallets', {
  address:               text('address').primaryKey(),
  ageSeconds:            integer('age_seconds').notNull(),
  totalTransactions:     integer('total_transactions').notNull(),
  isContract:            boolean('is_contract').default(false),
  controllerAddress:     text('controller_address'),
  firstSeenAt:           timestamp('first_seen_at').notNull(),
  lastActiveAt:          timestamp('last_active_at').notNull(),

  totalMarkets:          integer('total_markets').default(0),
  totalFills:            integer('total_fills').default(0),
  totalVolumeUsd:        numeric('total_volume_usd', { precision: 20, scale: 6 }).default('0'),
  resolvedPositions:     integer('resolved_positions').default(0),
  wins:                  integer('wins').default(0),
  winRate:               doublePrecision('win_rate'),
  avgEdgeAtEntry:        doublePrecision('avg_edge_at_entry'),
  edgeTTestPValue:       doublePrecision('edge_ttest_p_value'),
  totalPnlUsd:           numeric('total_pnl_usd', { precision: 20, scale: 6 }).default('0'),

  categoryConcentration: doublePrecision('category_concentration'),
  topCategories:         jsonb('top_categories').$type<string[]>().default([]),
  avgEntryTimingMinutes: doublePrecision('avg_entry_timing_minutes'),
  preResolutionRatio:    doublePrecision('pre_resolution_ratio'),
  avgPositionSizePct:    doublePrecision('avg_position_size_pct'),
  lumpEntryRatio:        doublePrecision('lump_entry_ratio'),
  convictionRatio:       doublePrecision('conviction_ratio'),

  fundingClusterId:      text('funding_cluster_id'),
  fundingGraphBuiltAt:   timestamp('funding_graph_built_at'),

  liveSuspicionScore:    doublePrecision('live_suspicion_score').default(0),
  retrospectiveScore:    doublePrecision('retrospective_score').default(0),
  liveTier:              text('live_tier').$type<AlertTier>().default('CLEAN'),
  retrospectiveTier:     text('retrospective_tier').$type<AlertTier>().default('CLEAN'),

  isWhitelisted:         boolean('is_whitelisted').default(false),
  labels:                jsonb('labels').$type<string[]>().default([]),
  notes:                 text('notes').default(''),

  createdAt:             timestamp('created_at').defaultNow(),
  updatedAt:             timestamp('updated_at').defaultNow(),
}, (table) => [
  index('idx_wallets_live_score').on(table.liveSuspicionScore),
  index('idx_wallets_retro_score').on(table.retrospectiveScore),
  index('idx_wallets_live_tier').on(table.liveTier),
  index('idx_wallets_cluster').on(table.fundingClusterId),
]);

// ═══════════════════════════════════════════════════════════════
// SIGNAL EVENTS — Normalized, append-only history of signal firings.
// Queryable: "which signals fire most?", "which predict best?"
// ═══════════════════════════════════════════════════════════════

export const signalEvents = pgTable('signal_events', {
  id:              text('id').primaryKey(),             // ulid
  walletAddress:   text('wallet_address').notNull(),
  marketId:        text('market_id'),
  fillId:          text('fill_id'),                     // Source fill (LIVE signals only)
  signalId:        text('signal_id').notNull(),
  availability:    text('availability').notNull(),       // LIVE | POST_RESOLUTION
  score:           doublePrecision('score').notNull(),
  confidence:      doublePrecision('confidence').notNull(),
  evidence:        jsonb('evidence').$type<SignalEvidence[]>().notNull(),
  scoringVersion:  text('scoring_version').notNull(),
  createdAt:       timestamp('created_at').defaultNow(),
}, (table) => [
  // Dual idempotency:
  // LIVE signals: keyed by (fillId, signalId) — one signal per fill per type
  uniqueIndex('idx_signal_events_live_idemp')
    .on(table.fillId, table.signalId),
  // POST_RESOLUTION signals: keyed by (walletAddress, marketId, signalId)
  // These aren't triggered by a single fill but by market resolution
  uniqueIndex('idx_signal_events_retro_idemp')
    .on(table.walletAddress, table.marketId, table.signalId)
    .where('fill_id IS NULL'),
  index('idx_signal_events_wallet').on(table.walletAddress),
  index('idx_signal_events_signal').on(table.signalId),
  index('idx_signal_events_market').on(table.marketId),
  index('idx_signal_events_created').on(table.createdAt),
  index('idx_signal_events_version').on(table.scoringVersion),
]);

// ═══════════════════════════════════════════════════════════════
// WALLET SNAPSHOTS — Temporal profile at time of significant fill.
// Throttled: 1/wallet/hour, only on >$500 fill or signal fire.
// Retention: SNAPSHOT_RETENTION_DAYS (default 180).
// ═══════════════════════════════════════════════════════════════

export const walletSnapshots = pgTable('wallet_snapshots', {
  id:              text('id').primaryKey(),
  walletAddress:   text('wallet_address').notNull(),
  snapshotAt:      timestamp('snapshot_at').notNull(),
  profile:         jsonb('profile').$type<WalletProfile>().notNull(),
  triggeredBy:     text('triggered_by'),
  scoringVersion:  text('scoring_version'),              // Scoring weights at snapshot time
  createdAt:       timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_snapshots_wallet').on(table.walletAddress),
  index('idx_snapshots_wallet_time').on(table.walletAddress, table.snapshotAt),
]);

// ═══════════════════════════════════════════════════════════════
// MARKETS
// ═══════════════════════════════════════════════════════════════

export const markets = pgTable('markets', {
  id:                  text('id').primaryKey(),
  question:            text('question').notNull(),
  category:            text('category').notNull(),
  subcategory:         text('subcategory'),
  endDate:             timestamp('end_date'),
  resolved:            boolean('resolved').default(false),
  outcome:             text('outcome'),
  resolvedAt:          timestamp('resolved_at'),
  resolutionType:      text('resolution_type').$type<ResolutionType>().default('UNKNOWN'),
  volumeUsd:           numeric('volume_usd', { precision: 20, scale: 6 }).default('0'),
  liquidityUsd:        numeric('liquidity_usd', { precision: 20, scale: 6 }).default('0'),
  dailyVolumeUsd:      numeric('daily_volume_usd', { precision: 20, scale: 6 }).default('0'),
  uniqueTraders:       integer('unique_traders').default(0),
  informationSource:   jsonb('information_source').$type<InformationSource>(),
  flaggedWalletCount:  integer('flagged_wallet_count').default(0),
  maxSuspicionScore:   doublePrecision('max_suspicion_score').default(0),
  anomalyLevel:        text('anomaly_level').default('NONE'),
  createdAt:           timestamp('created_at').defaultNow(),
  updatedAt:           timestamp('updated_at').defaultNow(),
}, (table) => [
  index('idx_markets_category').on(table.category),
  index('idx_markets_anomaly').on(table.anomalyLevel),
  index('idx_markets_resolved').on(table.resolved),
]);

// ═══════════════════════════════════════════════════════════════
// CLUSTERS, ALERTS, FUNDING EDGES — largely unchanged from v1.3
// but with numeric types for money fields.
// ═══════════════════════════════════════════════════════════════

export const clusters = pgTable('clusters', {
  id:                  text('id').primaryKey(),
  wallets:             jsonb('wallets').$type<string[]>().notNull(),
  sharedFundingSources: jsonb('shared_funding_sources').$type<string[]>().notNull(),
  evidence:            jsonb('evidence').$type<ClusterEvidence>().notNull(),
  suspicionScore:      doublePrecision('suspicion_score').default(0),
  totalVolumeUsd:      numeric('total_volume_usd', { precision: 20, scale: 6 }).default('0'),
  totalPnlUsd:         numeric('total_pnl_usd', { precision: 20, scale: 6 }).default('0'),
  marketsTraded:       jsonb('markets_traded').$type<string[]>().default([]),
  createdAt:           timestamp('created_at').defaultNow(),
  updatedAt:           timestamp('updated_at').defaultNow(),
});

export const alerts = pgTable('alerts', {
  id:              text('id').primaryKey(),
  walletAddress:   text('wallet_address').notNull(),
  marketId:        text('market_id'),
  tier:            text('tier').$type<AlertTier>().notNull(),
  scoreType:       text('score_type').notNull(),        // 'live' | 'retrospective'
  suspicionScore:  doublePrecision('suspicion_score').notNull(),
  signalIds:       jsonb('signal_ids').$type<string[]>().notNull(),
  summary:         text('summary').notNull(),
  scoringVersion:  text('scoring_version').notNull(),
  dispatched:      boolean('dispatched').default(false),
  dispatchedTo:    jsonb('dispatched_to').$type<string[]>().default([]),
  createdAt:       timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_alerts_tier').on(table.tier),
  index('idx_alerts_created').on(table.createdAt),
  index('idx_alerts_wallet').on(table.walletAddress),
]);

export const fundingEdges = pgTable('funding_edges', {
  id:              text('id').primaryKey(),
  fromAddress:     text('from_address').notNull(),
  toAddress:       text('to_address').notNull(),
  amountUsd:       numeric('amount_usd', { precision: 20, scale: 6 }).notNull(),
  asset:           text('asset').notNull(),              // 'USDC' | 'ETH' | 'MATIC'
  txHash:          text('tx_hash').notNull(),
  timestamp:       timestamp('timestamp').notNull(),
  depth:           integer('depth').notNull(),
  rootWallet:      text('root_wallet').notNull(),
  createdAt:       timestamp('created_at').defaultNow(),
  expiresAt:       timestamp('expires_at'),
}, (table) => [
  index('idx_funding_from').on(table.fromAddress),
  index('idx_funding_to').on(table.toAddress),
  index('idx_funding_root').on(table.rootWallet),
  index('idx_funding_root_created').on(table.rootWallet, table.createdAt),
  index('idx_funding_expires').on(table.expiresAt),
  uniqueIndex('idx_funding_unique').on(table.fromAddress, table.toAddress, table.txHash),
]);

// ═══════════════════════════════════════════════════════════════
// SUBSCRIPTIONS — Persisted state machine for market_watchlist.
// ═══════════════════════════════════════════════════════════════

export const subscriptions = pgTable('subscriptions', {
  id:              text('id').primaryKey(),             // ulid
  acpJobId:        text('acp_job_id').notNull(),
  buyerAddress:    text('buyer_address').notNull(),
  marketId:        text('market_id').notNull(),
  status:          text('status').notNull(),             // ACTIVE | COMPLETED | CANCELLED | EXPIRED
  pricePaidUsd:    numeric('price_paid_usd', { precision: 10, scale: 2 }).notNull(),
  startedAt:       timestamp('started_at').notNull(),
  expiresAt:       timestamp('expires_at').notNull(),    // startedAt + 30 days
  completedAt:     timestamp('completed_at'),
  completionReason: text('completion_reason'),           // RESOLVED | TIMEOUT | CANCELLED
  alertCount:      integer('alert_count').default(0),
  fillsScanned:    integer('fills_scanned').default(0),
  walletsAnalyzed: integer('wallets_analyzed').default(0),
  finalReportId:   text('final_report_id'),
  createdAt:       timestamp('created_at').defaultNow(),
  updatedAt:       timestamp('updated_at').defaultNow(),
}, (table) => [
  index('idx_subs_market').on(table.marketId),
  index('idx_subs_status').on(table.status),
  index('idx_subs_buyer').on(table.buyerAddress),
  index('idx_subs_expires').on(table.expiresAt),
]);

// ═══════════════════════════════════════════════════════════════
// WHALE WHITELIST — Known legitimate large traders/market makers.
// Excluded from signal evaluation to reduce noise.
// ═══════════════════════════════════════════════════════════════

export const whaleWhitelist = pgTable('whale_whitelist', {
  address:         text('address').primaryKey(),
  label:           text('label').notNull(),             // "Wintermute", "Jump", etc.
  reason:          text('reason').notNull(),            // Why whitelisted
  addedAt:         timestamp('added_at').defaultNow(),
  addedBy:         text('added_by').notNull(),          // 'auto' | 'manual'
});

// ═══════════════════════════════════════════════════════════════
// AUDIT LOG — Tracks all proxy attributions, whitelist changes,
// and manual overrides. Every trust-affecting decision is durable.
// ═══════════════════════════════════════════════════════════════

export const auditLog = pgTable('audit_log', {
  id:              text('id').primaryKey(),             // ulid
  action:          text('action').notNull(),            // 'WHITELIST_ADD' | 'WHITELIST_REMOVE' |
                                                        // 'PROXY_ATTRIBUTE' | 'PROXY_OVERRIDE' |
                                                        // 'LABEL_ADD' | 'LABEL_REMOVE'
  targetAddress:   text('target_address').notNull(),
  actor:           text('actor').notNull(),             // 'auto' | 'manual' | 'system'
  oldValue:        jsonb('old_value'),
  newValue:        jsonb('new_value'),
  reason:          text('reason').notNull(),
  createdAt:       timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_audit_target').on(table.targetAddress),
  index('idx_audit_action').on(table.action),
  index('idx_audit_created').on(table.createdAt),
]);

// ═══════════════════════════════════════════════════════════════
// INGEST QUARANTINE — Malformed or unexpected Polymarket payloads
// that fail Zod validation. Stashed for review instead of silently
// dropped or allowed to poison the fills ledger.
// ═══════════════════════════════════════════════════════════════

export const ingestQuarantine = pgTable('ingest_quarantine', {
  id:              text('id').primaryKey(),             // ulid
  source:          text('source').notNull(),            // 'polymarket_clob' | 'polymarket_ws'
  rawPayload:      jsonb('raw_payload').notNull(),      // Exact payload as received
  errorReason:     text('error_reason').notNull(),      // Zod error or validation failure
  createdAt:       timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_quarantine_source').on(table.source),
  index('idx_quarantine_created').on(table.createdAt),
]);
```

**Retention policies**:
- `fills`: resolved markets older than `FILL_RETENTION_DAYS` (default 365) are archived
- `walletSnapshots`: older than `SNAPSHOT_RETENTION_DAYS` (default 180)
- `fundingEdges`: `expiresAt` based, `FUNDING_GRAPH_TTL_DAYS` (default 90)
- `signalEvents`: older than `SIGNAL_EVENT_RETENTION_DAYS` (default 365)

---

## 11. Configuration

> **Config management**: Use **TOML** (`omen.config.toml`) as the single source for all
> tuning parameters (thresholds, weights, retention, backpressure). Versionable, diffable,
> inspectable via `omen config show`. Environment variables are for **secrets and
> deployment-specific values only**. The Zod config schema validates both sources on
> startup. Env vars override TOML values when set.

```bash
# .env.example — secrets and deployment-specific values ONLY.
# All tuning parameters live in omen.config.toml.

OMEN_POSTGRES_PORT=15432
OMEN_REDIS_PORT=16379
DATABASE_URL=postgresql://omen:omen@localhost:15432/omen
REDIS_URL=redis://localhost:16379
ALCHEMY_API_KEY=your-alchemy-key

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID_CRITICAL=
TELEGRAM_CHAT_ID_MEDIUM=
DISCORD_WEBHOOK_CRITICAL=
DISCORD_WEBHOOK_MEDIUM=

# ACP (Phase 3+, optional)
ACP_AGENT_PRIVATE_KEY=
ACP_BUILDER_CODE=

# Social check (optional)
GOOGLE_NEWS_API_KEY=
TWITTER_BEARER_TOKEN=

# Logging
LOG_LEVEL=info
LOG_PRETTY=true
```

```toml
# omen.config.toml — all tuning parameters. Versionable.
# Override any value via env var: OMEN_INGESTION_POLL_INTERVAL_MS=10000

[ingestion]
poll_interval_ms = 15_000
ws_enabled = true
ws_reconnect_ms = 5_000
max_concurrent_profiles = 10

[detection.fresh_wallet]
critical_age_hours = 24
elevated_age_hours = 72
max_txns = 10

[detection.market]
niche_max_volume = 100_000
large_position_min_usd = 1_000
large_position_volume_pct = 0.02

[detection.statistics]
p_value_threshold = 0.001
min_edge_threshold = 0.15
min_resolved_for_stats = 8

[detection.cluster]
min_size = 3
funding_max_depth = 4
fanout_limit = 5
max_rpc_calls = 200

[detection.timing_burst]
window_minutes = 30
min_wallets = 5

[detection.conviction]
max_wallet_volume = 5_000
min_size_ratio = 0.50
max_entry_price = 0.30

[detection.social_check]
enabled = false

[alerts]
critical_min_score = 80
high_min_score = 60
medium_min_score = 40
low_min_score = 20
dedup_cooldown_ms = 86_400_000
dedup_score_increase = 10

[retention]
fill_days = 365
funding_graph_ttl_days = 90
snapshot_days = 180
snapshot_min_interval_ms = 3_600_000
snapshot_min_trade_usd = 500
signal_event_days = 365

[backpressure]
hot_worker_queue_depth = 100

[whale_whitelist]
auto_detect_min_volume_usd = 500_000
auto_detect_min_markets = 100

[acp]
max_concurrent_jobs_per_buyer = 10
max_deep_scans_per_hour = 3
max_active_subscriptions = 50
max_subs_per_buyer = 5
job_coalesce_window_ms = 60_000

[operational]
dry_run = false
# scoring_version is NOT configurable — it's set in code at src/config/constants.ts
# and tied to release tags. Operator-tunable versioning would muddy analytics history.
```

---

## 12. Coding Standards

- **TypeScript strict mode** (`strict: true`, `noUncheckedIndexedAccess: true`)
- **No `any`** — `unknown` + narrowing or Zod
- **Explicit return types** on exported functions
- **Error handling**: `OmenError` base class, Result pattern for expected failures
- **Naming**: camelCase vars/functions, PascalCase types, UPPER_SNAKE constants, kebab files
- **DI via function params** — no framework, pass clients explicitly
- **No classes** unless managing stateful resources (DB pools, WS clients)
- **Module boundaries**: barrel exports via `index.ts`, cross-module imports through barrels
- **Side effects isolated**: only entry points (`index.ts`, `hot-worker.ts`, `cold-worker.ts`)
- **Thread boundary explicit**: typed MessagePort, no shared mutable state
- **Tests**: 90%+ on `src/analysis/`, 70%+ overall, fast-check for stats.
  Idempotency must be proven in integration tests (crash-replay scenarios for both
  LIVE and POST_RESOLUTION signal paths), not just relied upon via schema constraints.
- **Git**: conventional commits, squash merge, lefthook pre-commit

---

## 13. Implementation Phases

### Phase 0 — Validation Spike

Before any application code, verify Polymarket CLOB fill semantics against live data:

- [ ] Capture 24h of raw CLOB trade events, inspect payload structure
- [ ] Confirm dedup key: is `(txHash, tokenId)` unique per fill, or can a single tx
      produce multiple same-token fills? Check batch/partial fill behavior.
- [ ] Determine if CLOB provides event-level IDs that could serve as natural keys
- [ ] Test order-type inference: compare trade prices to orderbook snapshots, validate
      TAKER/MAKER classification accuracy
- [ ] Document findings in an ADR that locks the fills schema

This is the highest-risk schema decision. If the dedup key is wrong, the immutable
ledger — which everything derives from — becomes immutable garbage. Do this first.

### Phase 1 — Core Engine + TUI

- [ ] Project scaffold, docker-compose (PG + Redis)
- [ ] Hot path worker + MessagePort bridge + backpressure
- [ ] Cold path BullMQ worker (separate process)
- [ ] Polymarket CLOB REST client (primary)
- [ ] Polygon RPC client (cache-first) + contract/proxy detection
- [ ] Fills table (immutable ledger) + ingest checkpoint/replay
- [ ] Wallet profiler (lightweight, for hot path)
- [ ] Anomaly detector: LIVE signals only (FRESH_WALLET_LARGE_POSITION,
      NICHE_MARKET_ENTRY, CONVICTION_SIZE_MISMATCH, OUTSIZED_POSITION,
      LUMP_ENTRY, SYBIL_CLUSTER with cached graph)
- [ ] Signal events table (normalized, with scoringVersion)
- [ ] Whale whitelist (manual seed)
- [ ] Resilience: circuit breakers, rate limiters, sanitizers
- [ ] TUI: **Alert Feed + Status Bar only** (2 panels)
- [ ] Alert dispatcher: Telegram with dedup (market-scoped)
- [ ] Observability: pino structured logs with periodic stats (fill ingest rate,
      signal fire rate, hot worker latency, queue depth). Health endpoint via `health.ts`.
- [ ] DRY_RUN mode

**If schedule slips, cut in this order** (last → first):
1. Whale auto-detection (keep manual-only)
2. Discord alerts (Telegram is sufficient)
3. WS upgrade (REST-only is correct and complete)
4. Anything beyond 2-panel TUI

### Phase 2 — Deep Analysis + TUI Expansion

- [ ] WS trade stream upgrade (optional, improves latency)
- [ ] Cold path: funding graph builder (Alchemy, USDC + ETH)
- [ ] Cold path: cluster analyzer + SYBIL_CLUSTER deep scoring
- [ ] Cold path: deep profile builder (full fill history aggregation)
- [ ] Resolution updater: edge computation (raw + normalized in parallel),
      wallet re-scoring, POST_RESOLUTION signals
- [ ] STATISTICAL_IMPROBABILITY + PRE_RESOLUTION_TIMING + CATEGORY_HYPERSPECIALIZATION
- [ ] TIMING_CLUSTER_BURST (with social check, opt-in)
- [ ] Remaining Tier 2/3 signals
- [ ] Wallet snapshot creator (throttled, with scoringVersion)
- [ ] TUI expansion: Market Scanner, Wallet Inspector, Cluster Map (progressive disclosure)
- [ ] Backtest against labeled cases (Venezuela, KPMG, Axiom, France election, Trump cabinet)
- [ ] Whale auto-detection (if cut from Phase 1)
- [ ] **Kalshi early data**: append-only raw fill collector into parallel table. Feature-flagged.
      Zero analysis, zero UI — purely building the historical corpus for Phase 4.
      First thing to cut if Polymarket work or backtests slip.

> **Phase 3 gate**: ACP monetization begins only after Phase 2 backtests demonstrate real
> detection signal on labeled insider cases. If backtests don't validate, iterate on
> detection before adding commerce complexity.

### Phase 3 — ACP Monetization + Hardening

- [ ] ACP integration: offerings, handlers, seller runtime
- [ ] External DTO layer (tenant boundary)
- [ ] Griefing protection (quotas, coalescing, load shedding)
- [ ] Subscription table + watchlist state machine
- [ ] market_watchlist offering with tiered pricing
- [ ] Retention cleanup jobs (fills, snapshots, funding edges, signal events)
- [ ] Agent token launch via Virtuals Unicorn
- [ ] Performance: query tuning, connection pooling

### Phase 4 — Cross-Market + Expansion

- [ ] Cross-market correlator + information source classification (behind flag)
- [ ] LLM-assisted market classification
- [ ] Kalshi cross-venue analysis (data already collecting since Phase 2)
- [ ] Dune historical backfill
- [ ] Evaluate POSITION_FLIP signal candidate
- [ ] Evaluate normalized edge vs raw edge from Phase 2 backtests — adopt whichever
      predicts better, or keep both as separate signal inputs
- [ ] Comprehensive test suite finalization
- [ ] Documentation: README, ADRs, API reference

---

## 14. Open Questions

1. **Information source classification** — Manual + LLM hybrid is operationally messy.
   Keep behind a flag until base detector is proven useful. Defer to Phase 4.

2. **Legal/reputational framing** — System is positioned as market-integrity intelligence,
   not copy-trade tooling. Copy-trade is dropped from the roadmap. Get legal review before
   public ACP commercialization.

3. **Polymarket API stability** — REST-primary mitigates WS fragility. Cache aggressively,
   have Dune/subgraph fallbacks.

4. **Proxy wallet attribution** — Contract detection + controller tracing is Phase 1,
   but heuristics need validation against real Polymarket proxy patterns (Safe multisigs,
   custom proxy contracts). Add audit logging for all proxy attributions and a manual
   override mechanism for misclassifications. Default conservative: if controller can't
   be determined, don't fire FRESH_WALLET_LARGE_POSITION (false negative preferred over
   false positive).

5. **Fill dedup semantics** — `unique(txHash, tokenId)` may be too weak if Polymarket
   emits multiple same-token fills in one tx batch. **Verify against actual CLOB event
   payloads before locking schema.** A dedup bug here corrupts the immutable ledger.
   May need `unique(txHash, tokenId, price)` or event-level IDs. This is the single
   highest-priority verification task before Phase 1 code is written.

6. **Kalshi early data collection** — Cross-venue correlation (same insider, different
   platform) is the sharpest knife for political events. Kalshi is deferred to Phase 4
   for analysis, but **start ingesting Kalshi fills into a parallel table in Phase 2**.
   Don't let Phase 4 be "start collecting data" — the historical corpus matters.

7. **ACP gating** — Multiple reviewers flagged that ACP adds lifecycle/state complexity
   before the core detector is proven. Gate monetization behind "detector quality proven
   via backtests and live monitoring." Phase 3 ACP work should start only after Phase 2
   backtests show real detection signal on labeled cases.

8. **v2 modules** — Token launch insider detection reuses analysis engine, persistence,
   and ACP infra. Build one brutal vertical first, abstract only after feeling real pain.

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| **v1.8** | 2026-03-27 | **FINAL**. ACP prices raised to value-scaled levels ($25/$50/$75, watchlist $50-$200). CLI clarified: `omen start` supervises/spawns cold-worker; `omen acp start` is standalone-only mode; `--no-acp` flag; `omen config show` redacts secrets. `scoring_version` removed from TOML (lives in code, not operator config). `audit_log` table for all proxy attribution + whitelist changes (actor, old/new value, reason). `ingest_quarantine` table for malformed Polymarket payloads (stash for review, never silently drop). |
| **v1.7** | 2026-03-27 | CLI commands. TOML config (secrets-only `.env`). `fills.analyzed` clarification. Idempotency integration test requirement. |
| **v1.6** | 2026-03-27 | Phase 0 validation spike. Time estimates removed. Phase 1 cut order + observability. Idempotency split (LIVE vs POST_RESOLUTION keys). Normalized edge as parallel experiment. Kalshi Phase 2 tightened. |
| **v1.5** | 2026-03-27 | Market difficulty normalization. POSITION_FLIP signal candidate. `scoringVersion` on signal_events/alerts/snapshots. Exactly-once idempotency. Graceful shutdown. Autovacuum config. Worker OOM limitation. Structured config recommendation. Kalshi Phase 2 early data. Phase 3 ACP gate. Proxy audit logging. |
| **v1.4** | 2026-03-27 | Hot/cold path split. Fills as immutable ledger. `real`→`numeric`. Dual live/retrospective scoring. Signal availability tags. Proxy detection. Whale whitelist. `signal_events` + `subscriptions` + `whale_whitelist` tables. ACP prices raised, DTOs, griefing protection. TUI simplified. Copy-trade dropped. Input sanitization. Market-scoped dedup. |
| **v1.3** | 2026-03-27 | T-test calibration (MIN_RESOLVED 5→8). Scan depth tiers. Thread requestId. Wallet stub shape. edgeAtEntry flow. Orderbook cold-start. Trades unique index fix. Watchlist validation. |
| **v1.2** | 2026-03-27 | Binomial → t-test. avgEdgeAtEntry includes losers. Watchlist lifecycle. TIMING_CLUSTER_BURST social suppression. Worker DB isolation + heartbeat. Data retention. FK removal. Dedup write fix. |
| **v1.1** | 2026-03-27 | Renamed HAWKEYE → Omen. Worker threads. Funding trace scalability. Ink 5 TUI. Edge-adjusted stats. Resolution-type timing. 2 new signals. Snapshots. Dedup. Resilience. market_watchlist. DRY_RUN. |
| **v1.0** | 2026-03-27 | Initial spec (as HAWKEYE). 14 signals, Polymarket focus, PG + Redis, TUI, alerts, Virtuals ACP. |
