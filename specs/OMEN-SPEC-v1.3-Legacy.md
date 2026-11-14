# OMEN — Prediction Market Insider Detection System

> Note: this document is a historical design reference. Omen is a market-integrity research tool; it does not claim that any wallet or person is an insider, and it does not claim a proven trading edge. See the README for current shipped behavior and wording.


## Technical Specification · v1.3

> Full revision history at [end of document](#changelog).

---

## 1. Vision & Product Summary

Omen is a real-time prediction market intelligence system that detects insider trading
patterns, tracks suspicious wallets, and scores market integrity. It serves two audiences
simultaneously:

1. **Personal alpha tool** — continuous monitoring with tiered Telegram/Discord alerts,
   operated via a rich terminal dashboard (TUI)
2. **ACP service agent** — on-demand insider detection sold to other agents and users on the
   Virtuals Protocol Agent Commerce Protocol for USDC revenue

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
│  ┌─── MAIN THREAD (latency-sensitive) ──────────────────────────────┐   │
│  │                                                                   │   │
│  │  ┌────────────────────────────────────────────────────────────┐   │   │
│  │  │                    INGESTION LAYER                         │   │   │
│  │  │  ┌──────────────────┐  ┌──────────────────┐               │   │   │
│  │  │  │ Polymarket CLOB  │  │ Polygon RPC      │               │   │   │
│  │  │  │ • REST polling   │  │ • Wallet age     │               │   │   │
│  │  │  │ • WS trade feed  │  │ • Tx count       │               │   │   │
│  │  │  │ • Orderbook snap │  │ (cache-first)    │               │   │   │
│  │  │  └──────────────────┘  └──────────────────┘               │   │   │
│  │  └───────────────────────────┬────────────────────────────────┘   │   │
│  │                              │                                    │   │
│  │                         Redis pub/sub                             │   │
│  │                              │                                    │   │
│  │  ┌───────────────────────────┴────────────────────────────────┐   │   │
│  │  │                    PRESENTATION LAYER                      │   │   │
│  │  │  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐   │   │   │
│  │  │  │ TUI (Ink 5)  │  │ Alert Dispatch │  │ ACP Seller   │   │   │   │
│  │  │  │              │  │ (Telegram/DC)  │  │ Runtime      │   │   │   │
│  │  │  └──────────────┘  └────────────────┘  └──────────────┘   │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── WORKER THREAD (compute-heavy) ────────────────────────────────┐   │
│  │                                                                   │   │
│  │  ┌────────────────────────────────────────────────────────────┐   │   │
│  │  │                    ANALYSIS ENGINE                         │   │   │
│  │  │  ┌──────────────────┐  ┌──────────────────┐               │   │   │
│  │  │  │ Wallet Profiler  │  │ Anomaly Detector │               │   │   │
│  │  │  │ • Age scoring    │  │ • Signal matrix  │               │   │   │
│  │  │  │ • Edge-adjusted  │  │ • Composite      │               │   │   │
│  │  │  │   win rate       │  │   suspicion      │               │   │   │
│  │  │  │ • Category spec  │  │   score          │               │   │   │
│  │  │  └──────────────────┘  └──────────────────┘               │   │   │
│  │  │  ┌──────────────────┐  ┌──────────────────┐               │   │   │
│  │  │  │ Cluster Engine   │  │ Cross-Market     │               │   │   │
│  │  │  │ • Funding DAG    │  │ Correlator       │               │   │   │
│  │  │  │ • Sybil groups   │  │ • Info source    │               │   │   │
│  │  │  │ • Temporal corr  │  │   classification │               │   │   │
│  │  │  └──────────────────┘  └──────────────────┘               │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── BACKGROUND JOBS (BullMQ) ─────────────────────────────────────┐   │
│  │  • Funding graph builder (pre-computes DAG, caches in Postgres)  │   │
│  │  • Funding graph + snapshot cleanup (prune expired, daily)       │   │
│  │  • Historical backfill (bootstrap wallet profiles from Dune)     │   │
│  │  • Resolution tracker (updates win/loss + edge on resolution)    │   │
│  │  • Wallet snapshot creator (captures profile-at-time-of-trade)   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── PERSISTENCE ──────────────────────────────────────────────────┐   │
│  │  ┌──────────────────────┐  ┌──────────────────────────────────┐  │   │
│  │  │ PostgreSQL 16        │  │ Redis 7                          │  │   │
│  │  │ • Wallet profiles    │  │ • Trade event pub/sub            │  │   │
│  │  │ • Wallet snapshots   │  │ • Alert pub/sub                  │  │   │
│  │  │ • Funding graph      │  │ • Wallet profile cache           │  │   │
│  │  │ • Markets, positions │  │ • Rate limiting (external APIs)  │  │   │
│  │  │ • Clusters, alerts   │  │ • Alert dedup cooldowns          │  │   │
│  │  │ • Trades             │  │ • BullMQ job queue               │  │   │
│  │  └──────────────────────┘  └──────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Thread Architecture

The system runs as **two threads in a single Node.js process** communicating via
`worker_threads` `MessagePort`:

**Main thread** — latency-sensitive I/O: WebSocket trade stream, REST polling, TUI
rendering, alert dispatch, ACP seller runtime. Never runs CPU-bound analysis directly.
When a new trade arrives, it publishes to Redis and posts a message to the worker.

**Worker thread** — compute-heavy analysis: wallet profiling, signal evaluation, cluster
detection, statistical calculations, cross-market correlation. Receives trade/market
events from the main thread, runs analysis, returns results (scored profiles, triggered
alerts) back via MessagePort.

**BullMQ jobs** — background tasks that don't need real-time response: funding graph
pre-computation, historical backfill, resolution tracking, wallet snapshotting. These
run on the main thread's event loop (I/O-bound work) or can optionally spawn their own
workers for parallelism.

This separation ensures that a 30-second cluster analysis never blocks the WebSocket
trade stream or causes the TUI to freeze.

### 2.2 Database Connection Isolation

Each thread creates its own Drizzle client and connection pool on startup. Connection
pools are **not** shared across V8 isolates — `worker_threads` share process memory but
Drizzle/pg pools are not thread-safe across isolates.

```
Main thread pool:   max 5 connections  (ingestion writes, TUI reads, alert inserts)
Worker thread pool: max 10 connections (analysis is read-heavy: profiles, positions, graphs)
```

### 2.3 Worker Heartbeat

The worker thread sends a `{ type: 'HEARTBEAT' }` message every 5 seconds. If the main
thread does not receive a heartbeat within 15 seconds, it kills and restarts the worker.
The health check `workerThread` status is driven by heartbeat recency, not just the
thread's `exit` event — this catches silent crashes and infinite loops.

---

## 3. Tech Stack

### Runtime & Language

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Language          | TypeScript 5.x (strict) | Primary language, ACP SDK compat, strong typing     |
| Runtime           | Node.js 22 LTS         | Worker threads, stable WS, mature ecosystem         |
| Package manager   | pnpm                    | Fast, strict, good monorepo support if needed       |
| Module system     | ESM (`"type": "module"`)| Modern standard, top-level await, tree-shaking      |
| Thread comms      | `worker_threads`        | Zero-serialization for SharedArrayBuffer, MessagePort|

### Data & Persistence

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Primary DB        | PostgreSQL 16           | Relational queries for wallet graphs, JSONB flex    |
| ORM               | Drizzle ORM             | Type-safe, SQL-like, lightweight, great migrations  |
| Cache / Pub-Sub   | Redis 7 (via ioredis)   | Alert fan-out, wallet cache, rate limits, dedup     |
| Queue             | BullMQ                  | Background jobs: funding graph, backfill, snapshots |

### Data Sources

| Source             | Protocol          | Purpose                                           |
| ------------------ | ----------------- | ------------------------------------------------- |
| Polymarket CLOB    | REST + WebSocket  | Market data, trades, orderbook, positions          |
| Polygon RPC        | JSON-RPC (Alchemy)| Wallet age, tx count                               |
| Alchemy Transfers  | REST (indexed)    | `alchemy_getAssetTransfers` for USDC funding traces|
| Polymarket Gamma   | REST              | Market metadata, categories, resolution info       |
| Dune Analytics     | REST              | Historical backfill, bootstrap data                |

> **Note on funding traces**: Raw `debug_traceTransaction` calls are replaced with
> Alchemy's indexed `getAssetTransfers` endpoint, which returns USDC transfer history
> for an address without tracing individual transactions. This is orders of magnitude
> faster and avoids rate-limit issues at depth 4.

### TUI

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Framework         | Ink 5 + ink-ui          | React model for terminal UIs. Actively maintained, |
|                   |                         | growing ecosystem, composable components. Has      |
|                   |                         | table, spinner, scrollable primitives in ink-ui.   |
| Layout            | ink-ui `Box` + flexbox  | Familiar layout model for multi-pane dashboard     |
| Data display      | Custom components        | Alert feed, market table, wallet inspector         |

> **Why Ink 5 over blessed**: `blessed`/`neo-blessed` are effectively unmaintained with
> no upstream bug fixes. Ink 5 has an active community, npm download growth, and the
> `ink-ui` package now provides table, scrollable box, and multi-panel primitives that
> close the gap with blessed-contrib. The React component model also means TUI widgets
> can later be ported to a web dashboard with minimal logic rewrite.

### ACP Integration

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| SDK               | openclaw-acp            | Official Virtuals ACP CLI/SDK                      |
| Seller runtime    | ACP WebSocket seller    | Listens for incoming jobs, dispatches to handlers   |
| Offerings         | JSON offering manifest  | Declarative service definitions                     |

### Quality & Tooling

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Linting           | Biome                   | Fast, unified lint + format, replaces ESLint+Prettier |
| Testing           | Vitest                  | Fast, TS-native, watch mode, Jest-compatible API    |
| Property testing  | fast-check              | Property-based tests for statistical functions       |
| Schema validation | Zod                     | Runtime validation of API responses, config, inputs |
| Logging           | pino                    | Structured JSON logging, low overhead, pretty-print |
| Env / Secrets     | direnv + dotenv         | Existing workflow; `.env` for dev, direnv for prod  |
| Git hooks         | lefthook                | Lightweight pre-commit (lint, type-check, test)     |

---

## 4. Project Structure

```
omen-bot/
├── src/
│   ├── index.ts                        # Main entry: boots main thread
│   ├── worker.ts                       # Worker thread entry point
│   ├── cli.ts                          # CLI entry for one-off commands (future)
│   │
│   ├── config/
│   │   ├── index.ts                    # Config loader (env + defaults + validation)
│   │   ├── schema.ts                   # Zod schemas for all config
│   │   └── constants.ts                # Thresholds, weights, magic numbers
│   │
│   ├── ingestion/
│   │   ├── polymarket-client.ts        # REST client: markets, positions, trades
│   │   ├── polymarket-ws.ts           # WebSocket: real-time trade stream
│   │   ├── polygon-rpc.ts             # Wallet age, tx count (cache-first)
│   │   ├── alchemy-transfers.ts       # getAssetTransfers for USDC funding traces
│   │   ├── gamma-client.ts            # Market metadata, categories, resolution
│   │   ├── dune-client.ts             # Historical data backfill
│   │   └── types.ts                    # Raw API response types
│   │
│   ├── analysis/
│   │   ├── wallet-profiler.ts          # Build/update wallet profiles
│   │   ├── anomaly-detector.ts         # Signal evaluation + composite scoring
│   │   ├── cluster-engine.ts           # Sybil detection, funding graph, shared-source
│   │   ├── statistical.ts              # One-sample t-test on edge, win-rate analysis
│   │   ├── cross-market-correlator.ts  # KPMG-pattern: common info source detection
│   │   ├── social-check.ts            # Google News + Twitter check for timing burst FP
│   │   ├── scoring-weights.ts          # Signal weights and threshold tuning
│   │   └── types.ts                    # Analysis domain types
│   │
│   ├── persistence/
│   │   ├── db.ts                       # Drizzle client + connection pool
│   │   ├── schema.ts                   # Drizzle table definitions
│   │   ├── migrations/                 # Drizzle migration files
│   │   ├── redis.ts                    # ioredis client + pub/sub helpers
│   │   ├── cache.ts                    # Wallet cache, funding graph cache
│   │   └── queries/
│   │       ├── wallets.ts              # Wallet CRUD + search + snapshots
│   │       ├── markets.ts              # Market metadata CRUD
│   │       ├── alerts.ts               # Alert history + dedup checks
│   │       ├── clusters.ts             # Cluster graph queries
│   │       └── funding-graph.ts        # Cached funding DAG operations
│   │
│   ├── engine/
│   │   ├── index.ts                    # Orchestrator: ties ingestion → analysis → output
│   │   ├── market-scanner.ts           # Continuous scan loop for active markets
│   │   ├── trade-processor.ts          # Process trades, dispatch to worker, dedup
│   │   ├── resolution-tracker.ts       # Track resolutions for retroactive scoring
│   │   └── thread-bridge.ts            # Main↔Worker MessagePort protocol
│   │
│   ├── jobs/
│   │   ├── queue.ts                    # BullMQ queue + worker setup
│   │   ├── funding-graph-builder.ts    # Pre-compute funding DAGs in background
│   │   ├── funding-graph-cleanup.ts    # Prune expired funding edges (daily)
│   │   ├── snapshot-cleanup.ts         # Prune old wallet snapshots (daily)
│   │   ├── backfill.ts                 # Bootstrap from Dune historical data
│   │   ├── snapshot-creator.ts         # Wallet profile snapshots at trade time
│   │   └── resolution-updater.ts       # Batch update win/loss on market resolution
│   │
│   ├── resilience/
│   │   ├── circuit-breaker.ts          # Per-service circuit breaker
│   │   ├── retry.ts                    # Exponential backoff with jitter
│   │   ├── rate-limiter.ts             # Token-bucket rate limiter for RPC/API calls
│   │   ├── dedup.ts                    # Alert deduplication (Redis-backed cooldowns)
│   │   └── health.ts                   # Health check for all external dependencies
│   │
│   ├── alerts/
│   │   ├── dispatcher.ts               # Route alerts by tier to channels (dedup-aware)
│   │   ├── telegram.ts                 # Telegram Bot API integration
│   │   ├── discord.ts                  # Discord webhook integration
│   │   ├── formatter.ts                # Rich alert message formatting
│   │   └── types.ts                    # Alert tier definitions
│   │
│   ├── acp/
│   │   ├── offerings/
│   │   │   ├── offering.json           # ACP service manifest
│   │   │   └── handlers.ts             # Job handler: route offering → analysis
│   │   ├── server.ts                   # ACP seller runtime bootstrap
│   │   └── response-formatter.ts       # Format analysis results for ACP output
│   │
│   ├── tui/
│   │   ├── app.tsx                     # Root Ink component
│   │   ├── components/
│   │   │   ├── alert-feed.tsx          # Scrolling live alert panel
│   │   │   ├── market-scanner.tsx      # Active markets table with anomaly counts
│   │   │   ├── wallet-inspector.tsx    # Detailed wallet profile view
│   │   │   ├── cluster-map.tsx         # ASCII funding graph visualization
│   │   │   ├── status-bar.tsx          # Connection state, counts, uptime
│   │   │   └── help-overlay.tsx        # Keybind reference overlay
│   │   ├── hooks/
│   │   │   ├── use-alerts.ts           # Subscribe to alert stream
│   │   │   ├── use-markets.ts          # Market scanner data
│   │   │   └── use-keyboard.ts         # Keyboard navigation
│   │   └── theme.ts                    # Color palette, border styles
│   │
│   └── types/
│       ├── wallet.ts                   # Wallet domain types
│       ├── market.ts                   # Market domain types
│       ├── signal.ts                   # Detection signal types
│       ├── alert.ts                    # Alert types
│       ├── thread-messages.ts          # Main↔Worker message protocol types
│       └── common.ts                   # Shared primitives (Address, MarketId, etc.)
│
├── tests/
│   ├── unit/
│   │   ├── analysis/
│   │   │   ├── wallet-profiler.test.ts
│   │   │   ├── anomaly-detector.test.ts
│   │   │   ├── cluster-engine.test.ts
│   │   │   ├── statistical.test.ts
│   │   │   └── cross-market.test.ts
│   │   ├── engine/
│   │   │   └── trade-processor.test.ts
│   │   └── resilience/
│   │       ├── circuit-breaker.test.ts
│   │       └── dedup.test.ts
│   ├── integration/
│   │   ├── polymarket-client.test.ts
│   │   ├── alchemy-transfers.test.ts
│   │   ├── social-check.test.ts
│   │   └── acp-handler.test.ts
│   └── fixtures/
│       ├── wallets.json                # Sample wallet profiles
│       ├── trades.json                 # Sample trade events
│       ├── markets.json                # Sample market metadata
│       └── insider-cases/              # Labeled historical insider cases
│           ├── venezuela-raid.json
│           ├── kpmg-earnings.json
│           └── axiom-zachxbt.json
│
├── scripts/
│   ├── backtest.ts                     # Validate detection against labeled cases
│   ├── seed-db.ts                      # Seed DB with test data
│   ├── calibrate-weights.ts            # Tune scoring weights against labeled dataset
│   └── bootstrap-from-dune.ts          # Initial historical data load
│
├── drizzle.config.ts
├── vitest.config.ts
├── biome.json
├── tsconfig.json
├── package.json
├── .env.example
├── .envrc
├── docker-compose.yml                  # PostgreSQL + Redis for local dev
└── README.md
```

---

## 5. Domain Types

### 5.1 Wallet Profile

```typescript
// src/types/wallet.ts

/** Polygon address (0x-prefixed, checksummed) */
export type Address = `0x${string}`;

export interface WalletProfile {
  address: Address;

  // Identity
  ageSeconds: number;
  totalTransactions: number;
  firstSeenAt: Date;
  lastActiveAt: Date;

  // Polymarket Activity
  totalMarkets: number;
  totalPositions: number;
  activePositions: number;
  totalVolumeUsd: number;

  // Performance — edge-adjusted model
  resolvedPositions: number;
  wins: number;
  losses: number;
  winRate: number;                 // wins / resolvedPositions
  avgEdgeAtEntry: number;          // Avg (resolutionValue - entryPrice) across ALL resolved
                                   //   positions, including losers (where edge is negative).
                                   //   e.g. bought YES at $0.30, resolved YES → edge = +0.70
                                   //   e.g. bought YES at $0.60, resolved NO  → edge = -0.60
                                   //   A wallet with 3 wins at +0.70 and 7 losses at -0.15
                                   //   has avgEdge = (3*0.70 + 7*-0.15) / 10 = +0.105
  edgeTTestPValue: number;         // One-sample t-test: is mean edge significantly > 0?
  totalPnlUsd: number;

  // Behavioral Signals
  categoryConcentration: number;   // 0-1, Herfindahl index across categories
  topCategories: string[];
  avgEntryTimingMinutes: number;   // Avg minutes before resolution when entering
  preResolutionRatio: number;      // % of trades placed <60min before resolution
  avgPositionSizePct: number;      // Avg position size as % of wallet balance
  lumpEntryRatio: number;          // % of entries that are single-fill vs accumulation
  convictionRatio: number;         // Largest single position / totalVolumeUsd

  // Funding
  fundingSources: FundingSource[];
  fundingClusterId: string | null;
  fundingGraphBuiltAt: Date | null; // When the funding DAG was last computed

  // Scoring
  suspicionScore: number;          // 0-100 composite score (real, not integer)
  signals: TriggeredSignal[];
  tier: AlertTier;

  // Metadata
  labels: string[];
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FundingSource {
  address: Address;
  label: string | null;            // "Binance Hot Wallet", "Coinbase", "Unknown EOA"
  amountUsd: number;
  txHash: string;
  timestamp: Date;
  depth: number;                   // How many hops from target wallet
}
```

### 5.2 Detection Signals

```typescript
// src/types/signal.ts

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

export interface SignalDefinition {
  id: SignalId;
  tier: 1 | 2 | 3;
  name: string;
  description: string;
  weight: number;
  threshold: Record<string, number>;
  evaluate: (ctx: SignalContext) => SignalResult;
}

export interface SignalContext {
  wallet: WalletProfile;
  trade?: TradeEvent;
  market?: MarketInfo;
  cluster?: WalletCluster;
  relatedWallets?: WalletProfile[];
  recentMarketTrades?: TradeEvent[];  // For TIMING_CLUSTER_BURST detection
}

export interface SignalResult {
  triggered: boolean;
  score: number;                   // 0-100 individual signal score
  confidence: number;              // 0-1 confidence in this signal
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

### 5.3 Market & Trade Types

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
  resolutionType: ResolutionType;  // Determines PRE_RESOLUTION_TIMING thresholds

  // Liquidity & Activity
  volumeUsd: number;
  liquidityUsd: number;
  dailyVolumeUsd: number;
  uniqueTraders: number;

  // Enrichment
  informationSource: InformationSource | null;

  // Anomaly Summary
  flaggedWalletCount: number;
  maxSuspicionScore: number;
  anomalyLevel: 'NONE' | 'LOW' | 'ELEVATED' | 'HIGH' | 'CRITICAL';
}

export interface InformationSource {
  type: InformationSourceType;
  entity: string;                  // "KPMG", "US Senate", "OpenAI", etc.
  confidence: number;
}

export type InformationSourceType =
  | 'AUDITOR'
  | 'GOVERNMENT_AGENCY'
  | 'POLITICAL_BODY'
  | 'CORPORATE_INSIDER'
  | 'MILITARY_INTELLIGENCE'
  | 'SPORTS_ORGANIZATION'
  | 'CRYPTO_PROJECT'
  | 'MEDIA_ORGANIZATION'
  | 'UNKNOWN';

export interface TradeEvent {
  id: string;                      // ulid, generated on ingestion
  marketId: MarketId;
  tokenId: TokenId;                // Polymarket CLOB token_id (YES or NO token)
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  price: number;                   // 0.00 - 1.00
  size: number;                    // Number of shares
  sizeUsd: number;
  maker: Address;
  timestamp: Date;
  txHash: string;

  // Order type classification heuristic:
  //   The Polymarket CLOB WS trade stream provides trades but not the orderbook
  //   state at trade time. To classify TAKER vs MAKER:
  //
  //   1. Maintain a local orderbook mirror from the WS book updates
  //   2. On each trade, compare trade price to last known best bid/ask:
  //      - BUY at price >= best ask → TAKER (aggressive, crossing the spread)
  //      - SELL at price <= best bid → TAKER
  //      - Otherwise → MAKER (resting order that was filled)
  //   3. If no orderbook data available for this market → UNKNOWN
  //
  //   This matters for the MARKET_ORDER_ONLY signal: insiders tend to use
  //   aggressive taker orders (they want fills, not spread capture).
  //   Legitimate whales also use taker flow, so this signal is Tier 3 only.
  orderType: 'TAKER' | 'MAKER' | 'UNKNOWN';
}
```

### 5.4 Cluster Types

```typescript
// src/types/cluster.ts

export interface WalletCluster {
  id: string;
  wallets: Address[];
  sharedFundingSources: Address[];
  evidence: ClusterEvidence;
  suspicionScore: number;
  totalVolumeUsd: number;
  totalPnlUsd: number;
  marketsTraded: MarketId[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ClusterEvidence {
  fundingOverlap: {
    commonAncestors: Address[];
    maxDepth: number;
  };
  temporalCorrelation: {
    avgTimeBetweenEntries: number;
    sameMarketEntries: number;
  };
  behavioralSimilarity: {
    sameCategoriesPct: number;
    sameOutcomePct: number;
  };
  informationSourceOverlap: {
    sharedSources: string[];
    sourceCorrelation: number;
  };
}
```

### 5.5 Thread Message Protocol

```typescript
// src/types/thread-messages.ts

/**
 * All request messages carry a `requestId` (ulid) so the main thread can
 * correlate responses when multiple requests are in flight simultaneously.
 * Worker echoes the requestId in its response. HEARTBEAT and ALERT are
 * unsolicited (no requestId).
 */

/** Messages from main thread → worker thread */
export type MainToWorkerMessage =
  | { type: 'ANALYZE_TRADE'; requestId: string; payload: { trade: TradeEvent; market: MarketInfo } }
  | { type: 'PROFILE_WALLET'; requestId: string; payload: { address: Address; forceRefresh: boolean } }
  | { type: 'ANALYZE_CLUSTER'; requestId: string; payload: { address: Address; maxDepth: number } }
  | { type: 'SCAN_MARKET'; requestId: string; payload: { marketId: MarketId } };

/** Messages from worker thread → main thread */
export type WorkerToMainMessage =
  | { type: 'HEARTBEAT' }
  | { type: 'ALERT'; payload: { alert: Alert } }
  | { type: 'PROFILE_RESULT'; requestId: string; payload: { profile: WalletProfile } }
  | { type: 'CLUSTER_RESULT'; requestId: string; payload: { cluster: WalletCluster } }
  | { type: 'MARKET_SCAN_RESULT'; requestId: string; payload: { marketId: MarketId; flaggedWallets: WalletProfile[] } }
  | { type: 'ERROR'; requestId: string; payload: { requestType: string; error: string } };
```

---

## 6. Detection Engine — Signal Definitions

### 6.1 Scoring Model

```typescript
// src/analysis/scoring-weights.ts

export const SIGNAL_WEIGHTS: Record<SignalId, number> = {
  // Tier 1 — max 30 points each
  FRESH_WALLET_LARGE_POSITION:    30,
  PRE_RESOLUTION_TIMING:          25,
  STATISTICAL_IMPROBABILITY:      30,
  SYBIL_CLUSTER:                  25,

  // Tier 2 — max 15 points each
  CATEGORY_HYPERSPECIALIZATION:   10,
  OUTSIZED_POSITION:              12,
  LUMP_ENTRY:                     8,
  CROSS_MARKET_COMMON_SOURCE:     15,
  CONVICTION_SIZE_MISMATCH:       14,
  TIMING_CLUSTER_BURST:           13,

  // Tier 3 — max 8 points each
  CEX_FUNDING_BEFORE_BET:         8,
  RAPID_POST_RESOLUTION_EXIT:     5,
  MARKET_ORDER_ONLY:              5,
  NICHE_MARKET_ENTRY:             7,
};

export const TIER_THRESHOLDS: Record<AlertTier, number> = {
  CRITICAL: 80,
  HIGH:     60,
  MEDIUM:   40,
  LOW:      20,
  CLEAN:    0,
};
```

### 6.2 Signal Implementations

**FRESH_WALLET_LARGE_POSITION** (Tier 1, 30pts)

Two-tier wallet age threshold reflecting documented insider behavior:

```
walletAgeScore:
  < 24 hours  → 1.0  (maximum suspicion — most documented cases)
  24-72 hours → 0.6  (elevated)
  > 72 hours  → signal does not fire

IF walletAgeScore > 0
   AND wallet.totalTransactions < 10
   AND trade.sizeUsd > max(market.dailyVolumeUsd * 0.02, $1000)
   AND market.dailyVolumeUsd < $100,000
THEN score = walletAgeScore * f(positionSize, marketLiquidity) * weight
```

**STATISTICAL_IMPROBABILITY** (Tier 1, 30pts) — *One-sample t-test on edge distribution*

Simple win/loss is naive. A wallet buying YES at $0.90 on markets that resolve YES is
expected behavior. The real question: "did they consistently enter at prices that were
too good?" That's a continuous variable, not a binary one — so a binomial test is the
wrong framework entirely.

```
For each resolved position i (winners AND losers):
  entryPrice_i  = price paid
  resolution_i  = 1.0 if position's side won, 0.0 if lost
  edge_i        = resolution_i - entryPrice_i

  Examples:
    Bought YES at $0.30, resolved YES → edge = +0.70 (great entry)
    Bought YES at $0.85, resolved YES → edge = +0.15 (meh, expected)
    Bought YES at $0.60, resolved NO  → edge = -0.60 (loss)

Under null hypothesis (no insider info):
  Markets are efficient → E[edge] = 0 for random entries
  
One-sample t-test (one-sample variant against μ=0, NOT two-sample):
  H0: mean(edge) = 0
  H1: mean(edge) > 0  (one-tailed, testing for positive edge)
  t = (mean(edges) - 0) / (stdev(edges) / sqrt(n))
  pValue = 1 - cdf_t(t, df = n - 1)

Normality caveat: prediction market edge values are bimodal by construction
(wins cluster around +0.3 to +0.7, losses around -0.3 to -0.7). At small n
the t-test p-value is unreliable. Mitigation: require n >= 8 (not 5) so CLT
has more room to work. At n=5 the variance estimate is too noisy for a Tier 1
flag — other signals (fresh wallet, conviction, timing) catch insiders at that
stage. For v2, consider Wilcoxon signed-rank test (non-parametric, handles
bimodal distributions correctly).

Including losers is critical: a wallet with 3 wins at +0.70 edge but 7 losses
at -0.15 edge has a very different profile than one with 3 wins at +0.70 and
no losses. The losers are informative about whether the wins were skill or luck.

IF pValue < 0.001
   AND resolvedPositions >= 8
   AND avgEdgeAtEntry > 0.15  (meaningful positive edge, not noise)
THEN score = min(100, -log10(pValue) * 12 + avgEdgeAtEntry * 30)
```

**PRE_RESOLUTION_TIMING** (Tier 1, 25pts) — *Resolution-type aware*

Markets with scheduled resolution (earnings, elections) have different baseline timing
than surprise events. Thresholds adapt accordingly:

```
IF market.resolutionType == 'SCHEDULED':
  // Everyone knows when earnings drop; trading 30min before is less suspicious
  suspiciousWindow = 10 minutes
  elevatedWindow   = 30 minutes

IF market.resolutionType == 'UNSCHEDULED':
  // Surprise events: trading anytime in the hours before is suspicious
  suspiciousWindow = 60 minutes
  elevatedWindow   = 360 minutes  (6 hours)

IF market.resolutionType == 'UNKNOWN':
  // Conservative: use unscheduled thresholds
  suspiciousWindow = 60 minutes
  elevatedWindow   = 360 minutes

entryMinutesBefore = (market.resolvedAt - trade.timestamp) in minutes

IF entryMinutesBefore < suspiciousWindow
THEN score = 1.0 * weight
ELSE IF entryMinutesBefore < elevatedWindow
THEN score = 0.5 * weight
ELSE signal does not fire
```

**SYBIL_CLUSTER** (Tier 1, 25pts) — *Cache-first, fan-out limited*

```
1. Check Postgres funding_graph cache for target wallet
   - If fresh (< 24h old): use cached graph
   - If stale or missing: enqueue BullMQ job to rebuild, use whatever exists

2. For cached graph, identify wallets sharing a common funding ancestor
   - Fan-out limit: top 5 funding sources per hop (by USDC amount)
   - Max depth: 4 hops
   - Hard ceiling: 200 RPC calls per graph build

3. Apply temporal correlation among cluster members:
   Did they enter the same market within 1 hour of each other?

4. Apply behavioral similarity:
   Same categories? Same sides?

IF cluster.size >= 3
   AND fundingOverlap.commonAncestors.length >= 1
   AND temporalCorrelation.sameMarketEntries >= 2
THEN score = f(clusterSize, fundingDepth, temporalTightness) * weight
```

**CONVICTION_SIZE_MISMATCH** (Tier 2, 14pts) — *NEW in v1.1*

Catches small, inexperienced wallets making outsized longshot bets — a pattern exhibited
by documented KPMG insiders:

```
PRECONDITION: wallet.fundingClusterId === null
  (If wallet is part of a known Sybil cluster, the outsized bet is explained
   by coordinated cluster behavior, not individual conviction. Skip signal.)

IF wallet.totalVolumeUsd < $5,000   (small account)
   AND trade.sizeUsd > wallet.totalVolumeUsd * 0.50  (betting the farm)
   AND trade.price < 0.30            (longshot position)
THEN score = f(sizeRatio, priceLevel, accountAge) * weight

The combination of low experience + high conviction + longshot odds is extremely
unusual for legitimate traders. Quants don't bet their whole account on single
low-probability outcomes. Recreational bettors don't have the conviction to go
all-in on longshots. Insiders do.
```

**TIMING_CLUSTER_BURST** (Tier 2, 13pts) — *NEW in v1.1*

Detects information leaking through social networks — coordinated buying from
*unrelated* wallets (no shared funding source) on the same market in a tight window:

```
For a given market in a time window (default: 30 minutes):
  Count distinct wallets entering the same side (e.g. all buying YES)
  Exclude wallets that are already in a known Sybil cluster together

IF distinctWallets >= 5
   AND market.dailyVolumeUsd < $100,000  (niche market)
   AND allSameSide == true
   AND noSharedFundingSources == true
THEN:
  // False positive mitigation: check if burst is explained by public info
  // A crypto influencer tweet or news article can cause legitimate herding
  // that looks like coordinated insider buying
  
  socialCheck = querySocialCorrelation(market.question, windowStart)
  
  IF socialCheck.majorMentionsFound:
    score = f(walletCount, timeWindow, marketLiquidity) * weight * 0.5  // Halved
  ELSE:
    score = f(walletCount, timeWindow, marketLiquidity) * weight        // Full
```

**Social correlation check (v1 implementation)**:
Simple and bounded — no full social media monitoring. On signal fire:
1. Search Google News API for the market's question text within the last 4 hours
2. Check a curated list of 20-30 high-impact crypto/prediction-market Twitter accounts
   via Twitter search API for mentions in the last 2 hours
3. If either returns results → major mention found → reduce score by 50%

This is a *suppression* check, not a monitoring feed. It runs only when the signal
fires (low frequency), keeping API costs minimal. More sophisticated social monitoring
can be added in v2.

**CROSS_MARKET_COMMON_SOURCE** (Tier 2, 15pts) — *The KPMG Detector*

```
1. Maintain informationSource classification for all markets
   (manual for high-value categories + LLM-assisted for new markets)

2. For a wallet with wins across markets, group wins by informationSource

3. concentration = max(winsPerSource) / totalWins

IF concentration > 0.6
   AND totalWins >= 3
   AND informationSource.type != 'UNKNOWN'
THEN score = f(concentration, totalWins, entityType) * weight
```

### 6.3 Engine Operational Patterns

**Wallet stub upsert on first trade encounter**

When the trade processor sees a wallet address for the first time (no row in `wallets`
table), it upserts a minimal stub before inserting the position. This is necessary
because positions reference `walletAddress` and the profiler runs asynchronously after
trade ingestion.

```typescript
// Minimal wallet stub — all analysis fields use DB defaults (0, null, [], 'CLEAN')
const walletStub = {
  address: trade.maker,
  ageSeconds: 0,                    // Unknown until profiler queries Polygon
  totalTransactions: 0,             // Unknown until profiler queries Polygon
  firstSeenAt: trade.timestamp,     // Best available approximation
  lastActiveAt: trade.timestamp,
};
// Upsert: only insert if address doesn't exist, never overwrite a profiled wallet
await db.insert(wallets).values(walletStub).onConflictDoNothing();
```

**edgeAtEntry computation on market resolution**

The `edgeAtEntry` field on positions is computed retroactively by the `resolution-updater`
BullMQ job when a market resolves:

```
When a market resolves:
1. resolution-updater job fetches all positions for this market
2. For each position:
   - Set resolved = true
   - Set resolvedOutcome = market.outcome
   - Compute edgeAtEntry = (outcome matches position side ? 1.0 : 0.0) - avgEntryPrice
   - Compute pnlUsd from shares * edgeAtEntry
3. Recalculate wallet profiles for all affected wallets:
   - Recompute wins, losses, winRate, avgEdgeAtEntry, edgeTTestPValue
4. Re-run anomaly detector for updated wallets
   - Resolution is when STATISTICAL_IMPROBABILITY becomes computable for many wallets
   - New p-value may trigger or strengthen the signal
5. Create wallet snapshot if suspicionScore changed by > 5 points
```

Step 4 is critical — the system must re-score wallets after resolution, not just update
position records. A wallet that looked clean pre-resolution may become suspicious once
its edge and p-value are computed.

**Orderbook mirror cold-start**

The local orderbook mirror (used for TAKER/MAKER classification) is empty on startup and
after WS reconnects. Known limitation for v1:

- On WS connect, the system begins processing trades immediately
- Trades arriving before the first orderbook snapshot get `orderType: 'UNKNOWN'`
- Since MARKET_ORDER_ONLY is a Tier 3 signal worth only 5 points, the cold-start gap
  (typically <30 seconds) has negligible impact on detection quality
- v2 enhancement: request REST orderbook snapshot on connect, buffer trades, and
  retroactively classify once snapshot arrives

---

## 7. Resilience & Operational Patterns

### 7.1 Circuit Breakers

Each external service has its own circuit breaker:

```typescript
// src/resilience/circuit-breaker.ts

interface CircuitBreakerConfig {
  failureThreshold: number;   // Failures before opening (default: 5)
  resetTimeoutMs: number;     // Time in open state before half-open (default: 30000)
  halfOpenMaxCalls: number;   // Calls allowed in half-open to test recovery (default: 2)
}

// Per-service instances:
// - polymarketApi: { failureThreshold: 5, resetTimeoutMs: 15000 }
// - polygonRpc:    { failureThreshold: 3, resetTimeoutMs: 30000 }
// - alchemyApi:    { failureThreshold: 3, resetTimeoutMs: 60000 }
// - telegramBot:   { failureThreshold: 5, resetTimeoutMs: 10000 }
```

**Fallback behavior**:
- Polymarket WS drops → fall back to REST polling at 15s intervals
- Alchemy rate-limited → skip funding traces, score with available signals only
- Polygon RPC down → use cached wallet age data, flag profiles as "stale"
- Telegram down → buffer alerts in Redis, flush when connection recovers

### 7.2 Alert Deduplication

```typescript
// src/resilience/dedup.ts

interface DedupConfig {
  cooldownMs: number;          // Don't re-alert same wallet+signal within this window
  scoreIncreaseThreshold: number; // Re-alert if score increases by this much
}

// Default: 24-hour cooldown per wallet+signal combo
// Exception: re-alert if suspicionScore increases by >10 points
// Implementation: Redis key per wallet+signal with TTL = cooldownMs
// Key format: `omen:dedup:{walletAddress}:{signalId}`
// Value: last alerted score

async function shouldAlert(wallet: Address, signal: SignalId, newScore: number): Promise<boolean> {
  const key = `omen:dedup:${wallet}:${signal}`;
  const lastScore = await redis.get(key);
  if (lastScore === null) return true;  // Never alerted
  if (newScore - Number(lastScore) > config.scoreIncreaseThreshold) return true;
  return false; // Within cooldown
}

// CRITICAL: After dispatching an alert, write the cooldown entry.
// Without this, shouldAlert() would return true on every poll cycle.
async function recordAlert(wallet: Address, signal: SignalId, score: number): Promise<void> {
  const key = `omen:dedup:${wallet}:${signal}`;
  await redis.set(key, score.toString(), 'PX', config.cooldownMs);
}

// Usage in dispatcher:
//   if (await shouldAlert(wallet, signal, score)) {
//     await dispatch(alert);
//     await recordAlert(wallet, signal, score);
//   }
```

### 7.3 Rate Limiting

Token-bucket rate limiter for external API calls:

```
- Alchemy:         30 req/s  (free tier: 330 CU/s, getAssetTransfers = ~10 CU)
- Polymarket CLOB: 10 req/s  (undocumented, conservative)
- Polygon RPC:     20 req/s
- Gamma API:       5 req/s
```

### 7.4 Health Checks

```typescript
// src/resilience/health.ts

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    postgres: 'up' | 'down';
    redis: 'up' | 'down';
    polymarketWs: 'connected' | 'reconnecting' | 'disconnected';
    polymarketApi: 'up' | 'circuit_open' | 'down';
    alchemyApi: 'up' | 'circuit_open' | 'rate_limited' | 'down';
    workerThread: 'alive' | 'dead';
  };
  uptime: number;
  lastTradeProcessed: Date | null;
  trackedMarkets: number;
  trackedWallets: number;
}
```

Health status is displayed in the TUI status bar and logged periodically via pino.

---

## 8. ACP Integration

### 8.1 Offering Manifest

```json
{
  "market_insider_scan": {
    "description": "Scan a Polymarket market for insider trading signals. Returns flagged wallets with suspicion scores, evidence trails, and cluster analysis. Covers fresh wallet detection, edge-adjusted statistical anomalies, Sybil clustering, and cross-market correlation.",
    "price": "3.00",
    "currency": "USDC",
    "estimatedDelivery": "60s",
    "inputSchema": {
      "marketId": "string (Polymarket condition_id or URL)",
      "depth": "string? ('quick' | 'standard' | 'deep', default 'standard')"
    },
    "depthTiers": {
      "quick":    "Cached data only. Return existing profiles and signals for all tracked wallets in this market. No new profiling, no funding traces. ~5s.",
      "standard": "Refresh profiles for wallets with trades in last 24h. Use cached funding graph. All signals except CROSS_MARKET_COMMON_SOURCE. ~30-60s.",
      "deep":     "Force-refresh all wallet profiles. Rebuild funding graphs. Full signal matrix including cross-market correlation and cluster analysis. ~2-5min."
    }
  },
  "wallet_suspicion_score": {
    "description": "Compute a composite insider probability score for a Polymarket wallet. Includes edge-adjusted win rate, p-value testing, funding trail, category specialization, conviction analysis, and cluster membership.",
    "price": "1.50",
    "currency": "USDC",
    "estimatedDelivery": "30s",
    "note": "Returns cached profile if fresh (<1h). Deep funding trace runs async; initial response includes all signals except SYBIL_CLUSTER if funding graph not yet cached."
  },
  "cluster_analysis": {
    "description": "Map the full Sybil cluster for a wallet: shared funding sources, coordinated entries, behavioral similarity, common information source patterns.",
    "price": "5.00",
    "currency": "USDC",
    "estimatedDelivery": "120s",
    "note": "Uses pre-computed funding graph when available. Deep trace (maxDepth 4) may take up to 3 minutes for uncached wallets."
  },
  "market_watchlist": {
    "description": "Subscribe to continuous insider monitoring for a specific market. Receive alerts when new insider signals fire. Subscription runs until market resolves or is cancelled.",
    "price": "10.00",
    "currency": "USDC",
    "estimatedDelivery": "ongoing",
    "note": "Subscription offering. Alerts delivered via ACP job updates as they trigger."
  }
}
```

> **Delivery time rationale**: Revised from v1.0 after review. `wallet_suspicion_score`
> was previously 20s, which is unrealistic when funding traces are needed. The new
> approach returns a partial response immediately (all signals except cluster/funding)
> using cached data, with full results following asynchronously. The `cluster_analysis`
> offering is explicitly documented as potentially slow for uncached wallets.

### 8.2 ACP Job Handler

```typescript
// src/acp/offerings/handlers.ts

import type { JobInput, JobOutput } from '../types.js';
import { formatForAcp } from '../response-formatter.js';

export async function handleJob(
  offeringId: string,
  input: JobInput,
): Promise<JobOutput> {
  switch (offeringId) {
    case 'market_insider_scan': {
      const result = await analyzeMarket(input.marketId, {
        depth: input.depth ?? 'standard',
      });
      return formatForAcp('market_insider_scan', result);
    }

    case 'wallet_suspicion_score': {
      // Return cached profile if fresh, otherwise compute
      // Funding graph is cache-first: returns available data immediately,
      // enqueues background job if stale
      const profile = await profileWallet(input.address, {
        forceRefresh: false,
        maxWaitMs: 25_000,  // Timeout before returning partial results
      });
      return formatForAcp('wallet_suspicion_score', profile);
    }

    case 'cluster_analysis': {
      const cluster = await analyzeCluster(input.address, {
        maxDepth: input.maxDepth ?? 4,
        maxWaitMs: 110_000,
      });
      return formatForAcp('cluster_analysis', cluster);
    }

    case 'market_watchlist': {
      // Validate market exists and is still active before accepting payment
      const market = await getMarket(input.marketId);
      if (!market) throw new Error(`Market not found: ${input.marketId}`);
      if (market.resolved) throw new Error(`Market already resolved: ${input.marketId}`);
      const subscription = await subscribeToMarket(input.marketId);
      return formatForAcp('market_watchlist', subscription);
    }

    default:
      throw new Error(`Unknown offering: ${offeringId}`);
  }
}
```

### 8.3 Watchlist Subscription Lifecycle

The `market_watchlist` offering is a subscription, not a one-shot query. ACP jobs are
fundamentally request-response, so the subscription must map onto ACP's job lifecycle
cleanly. Here's the protocol:

**Purchase**: Consumer pays $10 via ACP job creation. The job enters `FUNDED` status.

**Monitoring phase**: Omen adds the market to its active watchlist. The ACP job stays
in `IN_PROGRESS` status. As insider signals fire, Omen pushes updates to the job via
ACP memo messages (the existing `MemoType.STATUS_UPDATE` mechanism). Each memo contains:
- The triggered signal summary
- Flagged wallet address + suspicion score
- Timestamp

The consumer's agent can poll the job's memo trail or subscribe to updates. This uses
ACP's built-in job messaging — no external webhook needed.

**Completion**: The job completes (transitions to `COMPLETED`) when one of:
1. **Market resolves** — Omen delivers a final comprehensive report: all insider signals
   detected during monitoring, wallet profiles, cluster analysis, and a retroactive
   accuracy assessment (did the flagged wallets actually win?). This final report is the
   formal deliverable that satisfies ACP evaluation.
2. **30-day timeout** — If the market hasn't resolved after 30 days, the job auto-completes
   with a summary of all activity to date. This prevents indefinite open jobs.
3. **Consumer cancellation** — Consumer can cancel via ACP. Partial results delivered as
   final report. No refund (monitoring resources were consumed).

**What constitutes successful delivery**: The final report is the deliverable. Even if
zero insider signals fired during monitoring, that's a valid outcome — "market was clean"
is actionable intelligence. The report includes:
- Monitoring duration and coverage
- Total trades scanned, unique wallets analyzed
- Any signals that fired (with full evidence)
- If none fired: an explicit "no anomalous activity detected" statement
- Retroactive accuracy (post-resolution): were any flagged wallets correct?

**Job state mapping**:
```
ACP FUNDED     → Market added to watchlist, monitoring begins
ACP IN_PROGRESS → Active monitoring, interim alerts via memos
ACP COMPLETED  → Final report delivered (resolution, timeout, or cancel)
ACP EXPIRED    → Market watchlist cleaned up, no final report
```

---

## 9. TUI Design

### 9.1 Layout

```
┌─ OMEN v1.0 ─────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌─ 🔴 LIVE ALERTS ──────────────────┬─ MARKET SCANNER ───────────────┐│
│  │ ▸ CRITICAL 12:34:05               │ Market              Vol   Flag ││
│  │   0x7a3…f91 → $15K YES on         │ Will X resign?     $234K  ●●● ││
│  │   "Will X resign?" (age: 2h,      │ BTC > 100K Mar?    $1.2M  ●   ││
│  │   3 txns, edge: 0.72)            │ KPMG earnings HD   $89K   ●●  ││
│  │                                    │ Iran ceasefire?     $3.1M  ●●● ││
│  │ ▸ HIGH 12:31:22                    │ Fed rate cut?       $890K      ││
│  │   Cluster [5 wallets] shared       │ ...                            ││
│  │   funding, $50K into Axiom mkt    │                                ││
│  │                                    │ [↑↓] Navigate  [Enter] Inspect ││
│  │ ▸ MEDIUM 12:28:10                  │ [f] Filter     [s] Sort        ││
│  │   0xabc…123 edge-adj p < 0.0001   │                                ││
│  │   avg edge: 0.58, 23 markets      │                                ││
│  ├─ WALLET INSPECTOR ────────────────┼─ CLUSTER MAP ──────────────────┤│
│  │ Address: 0x7a3...f91              │                                ││
│  │ Age: 2 hours │ Txns: 3            │  [Binance]                     ││
│  │ Score: 92/100 │ Tier: CRITICAL    │      │                         ││
│  │ Avg Edge: 0.72 │ p-val: <0.0001   │  0xdef…789 (2yr, 500 txns)    ││
│  │                                    │      │                         ││
│  │ Signals:                           │  ┌───┼───┐                     ││
│  │  ● FRESH_WALLET_LARGE_POS [30/30] │  │   │   │                     ││
│  │  ● CONVICTION_MISMATCH    [14/14] │ 0x7a3 0xb12 0xc45              ││
│  │  ● NICHE_MARKET_ENTRY     [ 7/ 7] │ ($15K) ($8K) ($12K)            ││
│  │  ○ SYBIL_CLUSTER          [--/25] │                                ││
│  │   └ (funding graph building...)    │ Shared source: Binance         ││
│  │                                    │ Temporal corr: 12min window    ││
│  │ Positions:                         │ Same-side rate: 100%           ││
│  │  "Will X resign?" YES @$0.08 $15K │                                ││
│  └────────────────────────────────────┴────────────────────────────────┘│
│  ● Connected │ Mkts: 1,247 │ Wallets: 3,891 │ Alerts: 47 │ ▲ Worker OK│
│  [q]Quit [?]Help [Tab]Focus [/]Search [r]Refresh [d]DryRun             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Keybinds

| Key         | Action                                     |
| ----------- | ------------------------------------------ |
| `Tab`       | Cycle focus between panels                 |
| `j` / `k`   | Scroll up/down in focused panel           |
| `Enter`     | Inspect selected item (wallet or market)   |
| `/`         | Search wallets or markets by address/name  |
| `f`         | Filter markets (category, anomaly level)   |
| `s`         | Sort current table (toggle column)         |
| `t`         | Toggle alert tier filter                   |
| `r`         | Force refresh selected wallet profile      |
| `d`         | Toggle dry-run mode (suppress dispatching) |
| `n`         | Add note to selected wallet                |
| `l`         | Toggle label on selected wallet            |
| `e`         | Export selected wallet/cluster to clipboard |
| `?`         | Help overlay                               |
| `q`         | Quit                                       |

---

## 10. Database Schema

```typescript
// src/persistence/schema.ts (Drizzle ORM)

import { pgTable, text, integer, real, boolean,
         timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const wallets = pgTable('wallets', {
  address:               text('address').primaryKey(),
  ageSeconds:            integer('age_seconds').notNull(),
  totalTransactions:     integer('total_transactions').notNull(),
  firstSeenAt:           timestamp('first_seen_at').notNull(),
  lastActiveAt:          timestamp('last_active_at').notNull(),

  totalMarkets:          integer('total_markets').default(0),
  totalPositions:        integer('total_positions').default(0),
  activePositions:       integer('active_positions').default(0),
  totalVolumeUsd:        real('total_volume_usd').default(0),
  resolvedPositions:     integer('resolved_positions').default(0),
  wins:                  integer('wins').default(0),
  winRate:               real('win_rate'),
  avgEdgeAtEntry:        real('avg_edge_at_entry'),
  edgeTTestPValue:       real('edge_ttest_p_value'),
  totalPnlUsd:           real('total_pnl_usd').default(0),

  categoryConcentration: real('category_concentration'),
  topCategories:         jsonb('top_categories').$type<string[]>().default([]),
  avgEntryTimingMinutes: real('avg_entry_timing_minutes'),
  preResolutionRatio:    real('pre_resolution_ratio'),
  avgPositionSizePct:    real('avg_position_size_pct'),
  lumpEntryRatio:        real('lump_entry_ratio'),
  convictionRatio:       real('conviction_ratio'),

  fundingSources:        jsonb('funding_sources').$type<FundingSource[]>().default([]),
  fundingClusterId:      text('funding_cluster_id'),
  fundingGraphBuiltAt:   timestamp('funding_graph_built_at'),

  suspicionScore:        real('suspicion_score').default(0),  // real, not integer
  signals:               jsonb('signals').$type<TriggeredSignal[]>().default([]),
  tier:                  text('tier').$type<AlertTier>().default('CLEAN'),
  labels:                jsonb('labels').$type<string[]>().default([]),
  notes:                 text('notes').default(''),

  createdAt:             timestamp('created_at').defaultNow(),
  updatedAt:             timestamp('updated_at').defaultNow(),
}, (table) => [
  index('idx_wallets_score').on(table.suspicionScore),
  index('idx_wallets_tier').on(table.tier),
  index('idx_wallets_cluster').on(table.fundingClusterId),
  index('idx_wallets_updated').on(table.updatedAt),
]);

// Temporal snapshots: captures wallet profile at time of each significant trade.
// Critical for retroactive analysis — a wallet may look normal now but was
// suspicious at the time of the insider trade.
//
// Snapshot throttling (prevents bloat):
//   A snapshot is created only when ALL of the following are true:
//   1. The trade meets a significance threshold:
//      (a) trade.sizeUsd > $500, OR
//      (b) it's the wallet's first trade in a new market, OR
//      (c) a detection signal fires on this trade
//   2. No snapshot exists for this wallet within the last 1 hour
//      (SNAPSHOT_MIN_INTERVAL_MS, default 3600000)
//
// Retention: snapshots older than SNAPSHOT_RETENTION_DAYS (default 180)
//   are pruned by a daily BullMQ cleanup job.
export const walletSnapshots = pgTable('wallet_snapshots', {
  id:                    text('id').primaryKey(),       // ulid
  walletAddress:         text('wallet_address').notNull(),
                         // No FK: same ingestion-before-profile issue as positions
  snapshotAt:            timestamp('snapshot_at').notNull(),
  profile:               jsonb('profile').$type<WalletProfile>().notNull(),
  triggeredBy:           text('triggered_by'),           // trade_id or event description
  createdAt:             timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_snapshots_wallet').on(table.walletAddress),
  index('idx_snapshots_time').on(table.snapshotAt),
  index('idx_snapshots_wallet_time').on(table.walletAddress, table.snapshotAt),
]);

export const markets = pgTable('markets', {
  id:                    text('id').primaryKey(),
  question:              text('question').notNull(),
  category:              text('category').notNull(),
  subcategory:           text('subcategory'),
  endDate:               timestamp('end_date'),
  resolved:              boolean('resolved').default(false),
  outcome:               text('outcome'),
  resolvedAt:            timestamp('resolved_at'),
  resolutionType:        text('resolution_type').$type<ResolutionType>().default('UNKNOWN'),

  volumeUsd:             real('volume_usd').default(0),
  liquidityUsd:          real('liquidity_usd').default(0),
  dailyVolumeUsd:        real('daily_volume_usd').default(0),
  uniqueTraders:         integer('unique_traders').default(0),

  informationSource:     jsonb('information_source').$type<InformationSource>(),

  flaggedWalletCount:    integer('flagged_wallet_count').default(0),
  maxSuspicionScore:     real('max_suspicion_score').default(0),
  anomalyLevel:          text('anomaly_level').default('NONE'),

  createdAt:             timestamp('created_at').defaultNow(),
  updatedAt:             timestamp('updated_at').defaultNow(),
}, (table) => [
  index('idx_markets_category').on(table.category),
  index('idx_markets_anomaly').on(table.anomalyLevel),
  index('idx_markets_resolved').on(table.resolved),
]);

export const positions = pgTable('positions', {
  id:                    text('id').primaryKey(),      // ulid (not composite key)
  walletAddress:         text('wallet_address').notNull(),
                         // No FK to wallets.address: trades are ingested before wallets
                         // are profiled. The trade processor upserts a minimal wallet stub
                         // (address + firstSeenAt only) on first encounter, then the
                         // profiler fills in the full profile asynchronously.
  marketId:              text('market_id').notNull(),
                         // No FK to markets.id for same reason: trades can arrive for
                         // markets not yet in our local DB during initial sync.
  tokenId:               text('token_id').notNull(),   // CLOB token_id (YES/NO specific)
  outcome:               text('outcome').notNull(),
  shares:                real('shares').notNull(),
  avgEntryPrice:         real('avg_entry_price').notNull(),
  totalCostUsd:          real('total_cost_usd').notNull(),
  entryTimestamp:        timestamp('entry_timestamp').notNull(),
  resolved:              boolean('resolved').default(false),
  resolvedOutcome:       text('resolved_outcome'),
  pnlUsd:               real('pnl_usd'),
  edgeAtEntry:           real('edge_at_entry'),        // resolution - entryPrice (computed)

  createdAt:             timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_positions_wallet').on(table.walletAddress),
  index('idx_positions_market').on(table.marketId),
  index('idx_positions_wallet_market').on(table.walletAddress, table.marketId),
]);

export const clusters = pgTable('clusters', {
  id:                    text('id').primaryKey(),
  wallets:               jsonb('wallets').$type<string[]>().notNull(),
  sharedFundingSources:  jsonb('shared_funding_sources').$type<string[]>().notNull(),
  evidence:              jsonb('evidence').$type<ClusterEvidence>().notNull(),
  suspicionScore:        real('suspicion_score').default(0),
  totalVolumeUsd:        real('total_volume_usd').default(0),
  totalPnlUsd:           real('total_pnl_usd').default(0),
  marketsTraded:         jsonb('markets_traded').$type<string[]>().default([]),
  createdAt:             timestamp('created_at').defaultNow(),
  updatedAt:             timestamp('updated_at').defaultNow(),
});

export const alerts = pgTable('alerts', {
  id:                    text('id').primaryKey(),
  walletAddress:         text('wallet_address').notNull(),
  marketId:              text('market_id'),
  tier:                  text('tier').$type<AlertTier>().notNull(),
  suspicionScore:        real('suspicion_score').notNull(),
  signals:               jsonb('signals').$type<TriggeredSignal[]>().notNull(),
  summary:               text('summary').notNull(),
  dispatched:            boolean('dispatched').default(false),
  dispatchedTo:          jsonb('dispatched_to').$type<string[]>().default([]),
  createdAt:             timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_alerts_tier').on(table.tier),
  index('idx_alerts_created').on(table.createdAt),
  index('idx_alerts_wallet').on(table.walletAddress),
]);

export const trades = pgTable('trades', {
  id:                    text('id').primaryKey(),       // ulid
  marketId:              text('market_id').notNull(),
  tokenId:               text('token_id').notNull(),
  walletAddress:         text('wallet_address').notNull(),
  side:                  text('side').notNull(),
  outcome:               text('outcome').notNull(),
  price:                 real('price').notNull(),
  shares:                real('shares').notNull(),
  sizeUsd:               real('size_usd').notNull(),
  txHash:                text('tx_hash').notNull(),
  orderType:             text('order_type'),
  timestamp:             timestamp('timestamp').notNull(),
  createdAt:             timestamp('created_at').defaultNow(),
}, (table) => [
  // Unique on (txHash, tokenId): a single Polymarket tx can fill multiple token
  // trades (e.g. buying YES + selling NO in a CLOB match). Without tokenId,
  // the second trade event from the same tx would be rejected as a duplicate.
  uniqueIndex('idx_trades_unique').on(table.txHash, table.tokenId),
  index('idx_trades_wallet').on(table.walletAddress),
  index('idx_trades_market').on(table.marketId),
  index('idx_trades_timestamp').on(table.timestamp),
]);

// Pre-computed funding graph edges, built by background BullMQ job.
// Cache-first strategy: analysis uses cached graph, background job refreshes.
// Retention: edges are pruned when the root wallet hasn't been active for
// FUNDING_GRAPH_TTL_DAYS (default 90). A daily BullMQ cleanup job deletes
// rows where expiresAt < now(). On graph rebuild, expiresAt is refreshed.
export const fundingEdges = pgTable('funding_edges', {
  id:                    text('id').primaryKey(),       // ulid
  fromAddress:           text('from_address').notNull(),
  toAddress:             text('to_address').notNull(),
  amountUsd:             real('amount_usd').notNull(),
  txHash:                text('tx_hash').notNull(),
  timestamp:             timestamp('timestamp').notNull(),
  depth:                 integer('depth').notNull(),    // Hop distance from target wallet
  rootWallet:            text('root_wallet').notNull(), // The wallet this graph was built for
  createdAt:             timestamp('created_at').defaultNow(),
  expiresAt:             timestamp('expires_at'),       // createdAt + FUNDING_GRAPH_TTL_DAYS
}, (table) => [
  index('idx_funding_from').on(table.fromAddress),
  index('idx_funding_to').on(table.toAddress),
  index('idx_funding_root').on(table.rootWallet),
  index('idx_funding_root_created').on(table.rootWallet, table.createdAt),
  index('idx_funding_expires').on(table.expiresAt),
  uniqueIndex('idx_funding_unique_edge').on(table.fromAddress, table.toAddress, table.txHash),
]);
```

---

## 11. Configuration

```bash
# .env.example

# ═══════════════════════════════════════════
# REQUIRED
# ═══════════════════════════════════════════

DATABASE_URL=postgresql://omen:omen@localhost:5432/omen
REDIS_URL=redis://localhost:6379

# Polygon RPC (Alchemy recommended for indexed transfers)
ALCHEMY_API_KEY=your-alchemy-key
# NOTE: POLYGON_RPC_URL is constructed in code as:
#   `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
# Do NOT use shell-style interpolation in .env — dotenv doesn't support it
# without dotenv-expand. The config loader builds the URL from the API key.

# ═══════════════════════════════════════════
# ALERTS
# ═══════════════════════════════════════════

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID_CRITICAL=       # Tier CRITICAL + HIGH
TELEGRAM_CHAT_ID_MEDIUM=         # Tier MEDIUM
DISCORD_WEBHOOK_CRITICAL=
DISCORD_WEBHOOK_MEDIUM=

# ═══════════════════════════════════════════
# ACP (optional)
# ═══════════════════════════════════════════

ACP_AGENT_PRIVATE_KEY=
ACP_BUILDER_CODE=

# ═══════════════════════════════════════════
# OPERATIONAL MODES
# ═══════════════════════════════════════════

DRY_RUN=false                     # Run full analysis, suppress alert dispatch + ACP

# ═══════════════════════════════════════════
# TUNING — Ingestion
# ═══════════════════════════════════════════

POLL_INTERVAL_MS=15000
TRADE_WS_RECONNECT_MS=5000
MAX_CONCURRENT_PROFILES=10

# ═══════════════════════════════════════════
# TUNING — Detection Thresholds
# ═══════════════════════════════════════════

# Fresh wallet (two-tier)
FRESH_WALLET_CRITICAL_AGE_HOURS=24
FRESH_WALLET_ELEVATED_AGE_HOURS=72
FRESH_WALLET_MAX_TXNS=10

# Market sizing
NICHE_MARKET_MAX_VOLUME=100000
LARGE_POSITION_MIN_USD=1000
LARGE_POSITION_VOLUME_PCT=0.02

# Statistical
PVALUE_THRESHOLD=0.001
WIN_RATE_SUSPICIOUS=0.80
MIN_EDGE_THRESHOLD=0.15
MIN_RESOLVED_FOR_STATS=8

# Clustering
CLUSTER_MIN_SIZE=3
CLUSTER_FUNDING_MAX_DEPTH=4
CLUSTER_FANOUT_LIMIT=5           # Max funding sources traced per hop
CLUSTER_MAX_RPC_CALLS=200        # Hard ceiling per graph build

# Timing burst
TIMING_BURST_WINDOW_MINUTES=30
TIMING_BURST_MIN_WALLETS=5

# Conviction mismatch
CONVICTION_MAX_WALLET_VOLUME=5000
CONVICTION_MIN_SIZE_RATIO=0.50
CONVICTION_MAX_ENTRY_PRICE=0.30

# Alert routing
ALERT_CRITICAL_MIN_SCORE=80
ALERT_HIGH_MIN_SCORE=60
ALERT_MEDIUM_MIN_SCORE=40
ALERT_LOW_MIN_SCORE=20

# Alert deduplication
ALERT_DEDUP_COOLDOWN_MS=86400000  # 24 hours
ALERT_DEDUP_SCORE_INCREASE=10     # Re-alert if score jumps by this much

# ═══════════════════════════════════════════
# TUNING — Data Retention
# ═══════════════════════════════════════════

FUNDING_GRAPH_TTL_DAYS=90         # Prune funding edges for inactive wallets
SNAPSHOT_RETENTION_DAYS=180       # Prune wallet snapshots older than this
SNAPSHOT_MIN_INTERVAL_MS=3600000  # Max 1 snapshot per wallet per hour
SNAPSHOT_MIN_TRADE_USD=500        # Min trade size to trigger snapshot

# ═══════════════════════════════════════════
# TUNING — Timing Burst Social Check
# ═══════════════════════════════════════════

GOOGLE_NEWS_API_KEY=              # Optional: for TIMING_CLUSTER_BURST false positive check
TWITTER_BEARER_TOKEN=             # Optional: for social correlation check
SOCIAL_CHECK_ENABLED=false        # Enable social suppression on timing burst signals

# ═══════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════

LOG_LEVEL=info
LOG_PRETTY=true
```

---

## 12. Coding Standards

### General

- **TypeScript strict mode** (`strict: true`, `noUncheckedIndexedAccess: true`)
- **No `any`** — use `unknown` + type narrowing or Zod `.parse()`
- **Explicit return types** on all exported functions
- **Const assertions** for literal types, discriminated unions for variants
- **Error handling**: custom error classes extending `OmenError` base; use Result pattern
  (`{ ok: true, data } | { ok: false, error }`) for expected failures (API errors,
  validation), throw only for unrecoverable errors
- **Naming**: camelCase variables/functions, PascalCase types/classes, UPPER_SNAKE
  constants, kebab-case files

### Architecture

- **Dependency injection via function parameters** — no DI framework. Pass clients and
  config explicitly. Makes testing trivial.
- **No classes unless managing stateful resources** (DB pools, WS clients). Pure functions
  are the default.
- **Module boundaries**: each `src/` subdirectory exports through `index.ts` barrel.
  Cross-module imports go through barrels only.
- **Side effects isolated**: only `src/index.ts`, `src/worker.ts`, and `src/cli.ts`
  perform side effects. Everything else is pure or takes injected clients.
- **Thread boundary is explicit**: all data crossing the worker thread boundary goes
  through typed `MessagePort` messages defined in `thread-messages.ts`. No shared mutable
  state between threads.

### Testing

- **Unit tests** for all analysis functions with fixtures + fast-check property tests
- **Integration tests** for data source clients with recorded HTTP responses (MSW)
- **Backtest script** validates detection against labeled historical insider cases
- **Target**: 90%+ coverage on `src/analysis/`, 70%+ overall
- **Test naming**: `describe('anomalyDetector')` → `it('flags fresh wallet with large niche position')`

### Git

- **Conventional commits**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- **Pre-commit**: Biome check, `tsc --noEmit`, Vitest related tests
- **Branch strategy**: `main` (stable), feature branches, squash merge

---

## 13. Implementation Phases

### Phase 1 — Core Engine + TUI (Weeks 1-2)

**Goal**: Live monitoring with fresh wallet + conviction detection, displayed in TUI.

- [ ] Project scaffold: TS config, Biome, Vitest, docker-compose (PG + Redis)
- [ ] Worker thread setup + MessagePort bridge
- [ ] Polymarket CLOB REST client + Gamma client
- [ ] Polygon RPC client (wallet age, tx count) with cache-first strategy
- [ ] Wallet Profiler: basic profile construction
- [ ] Anomaly Detector: FRESH_WALLET_LARGE_POSITION, NICHE_MARKET_ENTRY,
      CONVICTION_SIZE_MISMATCH signals
- [ ] Drizzle schema + migrations (all tables including snapshots + funding_edges)
- [ ] Engine: market scanner loop, trade processor with dedup
- [ ] Resilience: circuit breakers, rate limiters
- [ ] TUI: Ink 5 layout with Alert Feed + Market Scanner + Status Bar
- [ ] Alert Dispatcher: Telegram integration with dedup
- [ ] DRY_RUN mode

**Deliverable**: Running system that monitors Polymarket, flags suspicious fresh wallets
and conviction mismatches, displays in TUI, sends deduplicated Telegram alerts.

### Phase 2 — Statistical + Cluster Analysis (Weeks 3-4)

**Goal**: Full signal matrix, edge-adjusted stats, Sybil clustering.

- [ ] Polymarket WS trade stream (real-time)
- [ ] Alchemy `getAssetTransfers` integration
- [ ] Statistical module: edge-adjusted p-value, win rate analysis (with fast-check tests)
- [ ] STATISTICAL_IMPROBABILITY + PRE_RESOLUTION_TIMING (resolution-type aware)
- [ ] BullMQ funding graph builder (background, cache-first)
- [ ] Cluster Engine + SYBIL_CLUSTER signal
- [ ] TIMING_CLUSTER_BURST signal
- [ ] Remaining Tier 2 and Tier 3 signals
- [ ] Wallet snapshot creator (BullMQ job)
- [ ] TUI: Wallet Inspector, Cluster Map panels
- [ ] Resolution Tracker: retroactive win/loss + edge scoring
- [ ] Backtest against Venezuela, Axiom, KPMG labeled cases

**Deliverable**: Full detection engine with all 14 signals, validated against history.

### Phase 3 — ACP Agent + Cross-Market Correlation (Weeks 5-6)

**Goal**: Monetize via ACP. Add the KPMG-pattern detector.

- [ ] ACP integration: offerings, handlers, seller runtime
- [ ] Response formatter for ACP consumers
- [ ] Partial/async response pattern for slow operations
- [ ] Cross-Market Correlator + information source classification
- [ ] LLM-assisted market classification
- [ ] market_watchlist subscription offering
- [ ] Agent token launch via Virtuals Unicorn
- [ ] Graduation process for Butler visibility

**Deliverable**: Live ACP agent selling services for USDC. Cross-market detection live.

### Phase 4 — Hardening + Expansion (Weeks 7-8)

**Goal**: Production reliability, Kalshi, historical bootstrap.

- [ ] Dune Analytics backfill integration (bootstrap historical profiles)
- [ ] Kalshi API integration (cross-platform)
- [ ] Copy-trade signal generation
- [ ] Performance optimization: query tuning, connection pooling
- [ ] Comprehensive test suite finalization
- [ ] Monitoring: structured pino logs, health check integration
- [ ] Documentation: README, architecture decision records, API reference

**Deliverable**: Hardened production system with cross-platform intelligence.

---

## 14. Open Questions & Future Considerations

1. **Market classification bootstrapping** — Cross-market correlator needs market → info
   source mapping. Manual for top categories, LLM for new markets. Ambiguous markets with
   multiple possible info sources need a confidence-weighted approach.

2. **Copy-trade positioning** — System should be framed as "market integrity intelligence"
   rather than "insider copy-trade bot." Reputational risk otherwise.

3. **Polymarket API stability** — CLOB API is undocumented and may change. Cache
   aggressively, have fallback sources (Dune, subgraph).

4. **ACP pricing evolution** — Start at $1.50-5.00. Monitor job volume and adjust.
   The `market_watchlist` subscription model may generate more sustainable revenue than
   one-off scans.

5. **Token launch timing** — Deploy and prove reliability in ACP sandbox before launching
   the agent token. Bad completion rates will kill the agent's reputation score.

6. **v2 modules** — Token launch insider detection (Solana/Base) reuses the analysis
   engine, persistence, TUI, and ACP infra. The prediction market module is the reference
   implementation; the architecture is designed to be multi-module from the start.

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| **v1.3** | 2026-03-27 | **T-test calibration**: Raised `MIN_RESOLVED_FOR_STATS` from 5→8 (CLT unreliable at small n with bimodal edge distribution). Added normality caveat + Welch's note. Wilcoxon signed-rank test noted for v2. `MIN_EDGE_THRESHOLD` aligned to 0.15 throughout. |
| | | **Scan depth tiers defined**: `quick` (cached only, ~5s), `standard` (24h refresh, cached graph, ~30-60s), `deep` (force refresh all, full matrix, ~2-5min). |
| | | **Thread message correlation**: Added `requestId: string` (ulid) to all main→worker requests, echoed in responses. Enables ACP handler to match responses when multiple requests are in flight. |
| | | **Wallet stub shape**: Documented minimal upsert on first trade encounter (address, firstSeenAt, lastActiveAt; all analysis fields use DB defaults). |
| | | **edgeAtEntry computation flow**: Documented full resolution-updater pipeline: update positions → recompute wallet profiles → re-run anomaly detector → snapshot if score changed. Step 4 (re-scoring) is critical. |
| | | **Orderbook cold-start**: Documented as known v1 limitation. Trades before first WS snapshot get `orderType: 'UNKNOWN'`. Acceptable because MARKET_ORDER_ONLY is Tier 3 / 5pts. |
| | | **trades unique index**: Changed from `txHash` only to `(txHash, tokenId)` — single tx can fill multiple token trades in CLOB matching. |
| | | **Watchlist validation**: Handler now validates market exists and is unresolved before accepting payment. |
| | | **social-check.ts moved**: From `src/ingestion/` to `src/analysis/` — it's a signal-evaluation helper, not data acquisition. |
| **v1.2** | 2026-03-27 | **Statistical model**: Replaced binomial test with one-sample t-test on edge distribution. `edgeAdjustedPValue` → `edgeTTestPValue`. `avgEdgeAtEntry` now includes all resolved positions (losers too). |
| | | **Watchlist lifecycle** (§8.3): Defined ACP job mapping — `IN_PROGRESS` during monitoring with memo alerts, `COMPLETED` on resolution/timeout/cancel with final report. |
| | | **TIMING_CLUSTER_BURST**: Added social/news false-positive suppression (opt-in, score halved if public mentions found). |
| | | **Worker isolation**: Explicit DB pool per thread (main=5, worker=10). Worker heartbeat (5s/15s). |
| | | **Data retention**: `fundingEdges` gets `expiresAt` + cleanup job. Snapshots get significance criteria, hourly throttle, retention policy. |
| | | **Schema**: Removed FK constraints on positions + snapshots (ingestion-before-profile ordering). Alert dedup `recordAlert()` write-after-alert bug fix. dotenv interpolation fix. |
| | | **Signals**: CONVICTION_SIZE_MISMATCH excludes clustered wallets. MARKET_ORDER_ONLY orderType heuristic documented. |
| **v1.1** | 2026-03-27 | Renamed HAWKEYE → **Omen**. Multi-thread architecture (worker_threads). Funding trace scalability (Alchemy indexed transfers, fan-out limits, cache-first). Ink 5 TUI (replaced unmaintained blessed). Edge-adjusted statistical model. Resolution-type aware timing. Two new signals: CONVICTION_SIZE_MISMATCH, TIMING_CLUSTER_BURST. Wallet snapshots. Alert dedup. Resilience module. `market_watchlist` ACP offering. `fundingEdges` table. Two-tier fresh wallet threshold. DRY_RUN mode. |
| **v1.0** | 2026-03-27 | Initial spec (as HAWKEYE). 14 detection signals, Polymarket/Polygon focus, PostgreSQL + Redis, TUI dashboard, Telegram/Discord alerts, Virtuals ACP integration. |
