# OMEN — Personal Intelligence Platform

## Technical Specification · v2.0

> Full revision history at [end of document](#changelog).

---

## 1. Vision & Product Summary

Omen is a **personal intelligence platform** — an ever-expanding system that ingests
data from multiple sources, resolves entities across domains, detects patterns, and
surfaces actionable intelligence. Think: a personal Palantir meets Nansen, built for
one operator, designed to grow indefinitely.

### 1.1 The Platform

The long-term direction borrowed from Palantir is **entity-centric intelligence**:
multiple sources eventually project into a shared graph of wallets, markets, people,
organizations, events, and typed relationships between them.

That is **not** the current runtime contract for the prediction-market module. Today,
live scoring, alerting, replay, and operator workflows run on domain-specific tables
(`fills`, `wallets`, `signal_events`, `alerts`) optimized for the Polymarket detector.
The ontology is a later integration layer that should enrich investigation workflows
without disturbing the real-time detector.

The architectural bar for future platform work is therefore:

1. New data sources should be able to enrich the system without rewriting the hot path.
2. New investigative views should compose multiple sources without coupling those sources
   to one another.
3. Real-time detection should remain fast, conservative, and domain-specific even after
   broader ontology work exists.

### 1.2 The First Module: Prediction Market Intelligence

The MVP is a **market-integrity intelligence** module focused on Polymarket. It detects
insider trading patterns, tracks suspicious wallets, and scores market integrity. This
module is the hardest to build (entity resolution, statistical scoring, graph analysis)
and establishes the architectural patterns all future modules follow.

It serves two audiences:

1. **Personal alpha tool** — continuous monitoring with tiered Telegram/Discord alerts,
   operated via a terminal dashboard (TUI)
2. **ACP service agent** — on-demand insider detection sold to other agents and users on
   the Virtuals Protocol Agent Commerce Protocol for USDC revenue

The system is framed as **surveillance and research tooling**, not as a copy-trade or
front-running tool. Monetization is via intelligence services, not trade execution.

### 1.3 The Platform Trajectory

Omen grows by adding **connectors** (new data sources that populate the entity graph)
and **enrichment modules** (cross-domain analysis that no single connector can provide).
The current implementation plan covers the prediction market module (Phases 0-4). The
platform evolution plan (Phases 5-6) introduces the shared entity ontology and the first
cross-domain enrichments. See §15 for detailed platform architecture.

Planned connectors and modules (not all will be built — prioritize by value):

| Module | Data Sources | Entity Types Added | Key Questions Answered |
|--------|-------------|-------------------|----------------------|
| Prediction markets (current) | Polymarket, Kalshi | Wallet, Market, Cluster | "Who's insider trading?" |
| Identity attribution | ENS, Twitter, GitHub, Polymarket profiles | Person | "Who is this wallet?" |
| Event correlation | News RSS, gov calendars, Twitter | Event, Document | "What do the insiders know?" |
| Token intelligence | DEX trades, holder data, Solana/Base | Token, LiquidityPool | "Is this token safe?" |
| Social signals | Discord, Telegram, CT | Channel, Post | "What's the alpha chatter?" |
| Cyber threat intel | CVE feeds, Shodan, WHOIS, breach DBs | Domain, IP, Vulnerability | "What's the threat surface?" |

**Repository**: `omen-bot`

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            OMEN SYSTEM                                  │
│                                                                         │
│  ┌─── MAIN THREAD / PROCESS ────────────────────────────────────────┐   │
│  │  REST poller → persist fills → enqueue hot worker               │   │
│  │  Alert promotion + dispatch                                      │   │
│  │  Terminal dashboard or structured JSON logs                      │   │
│  │  Cold-worker child-process supervision                           │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── HOT WORKER THREAD (real-time scoring) ────────────────────────┐   │
│  │  Bounded in-memory queue (configurable; default 100)             │   │
│  │  Wallet stub upsert → chain profiling → LIVE signal eval         │   │
│  │  Persist signal events → promote operator alerts                 │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── COLD PATH PROCESS (BullMQ, durable) ──────────────────────────┐   │
│  │  Current: funding-graph rebuild jobs                             │   │
│  │  Future: deeper clustering, post-resolution scoring, ontology    │   │
│  │  projection, retention jobs, cross-domain enrichment             │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─── PERSISTENCE ──────────────────────────────────────────────────┐   │
│  │  PostgreSQL 16: current domain tables for detector state         │   │
│  │  Redis 7: BullMQ, alert dedup, health heartbeats                 │   │
│  │  Future: ontology tables for cross-domain investigation (§15)    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Hot Path / Cold Path Split

**Main thread / process** — handles Polymarket polling, fill persistence, replay
scheduling, alert dispatch, operator presentation, and supervision of the cold-worker
process. It does not consume BullMQ jobs directly.

**Hot worker thread** (`worker_threads`) — evaluates the current LIVE detector on each
persisted fill. The queue is bounded in memory. If the queue is full, enqueue returns
`full`; the system relies on `fills.analyzed = false` replay semantics to recover later.
The hot worker is intentionally narrow: lightweight wallet profiling, live signal
evaluation, signal persistence, and alert promotion.

**Cold path process** (`bullmq`) — durable background work with no real-time latency
budget. Today that means funding-graph rebuild jobs. The same boundary is where deeper
profile builds, post-resolution scoring, retention jobs, ontology projection, and
cross-domain enrichment belong later.

### 2.2 Async Backbone Responsibilities

| Mechanism     | Responsibility                          | NOT used for                        |
| ------------- | --------------------------------------- | ----------------------------------- |
| MessagePort   | Main ↔ hot-worker handoff               | Durable jobs, cross-process queues  |
| BullMQ        | Durable cold-path jobs                  | Real-time fill scoring              |
| Redis         | BullMQ backend, alert dedup, heartbeats | General internal event bus          |
| Stdout / TTY  | Structured logs and dashboard rendering | Inter-service messaging             |

### 2.3 Database Connection Isolation

```
Main process:      pg Pool max 5
Hot worker:        pg Pool max 5
Cold worker:       pg Pool max 5
```

The current code uses the same conservative pool size in each runtime. If Phase 2/3
adds more parallel cold-path jobs or ACP workloads, re-tune this intentionally rather
than letting implicit defaults drift.

### 2.4 Worker Heartbeat & Restart

Hot worker sends `HEARTBEAT` every 5s and also writes heartbeat state to Redis for the
`health` command. The current runtime **does not auto-restart the hot worker**; if the
thread errors, the process surfaces the failure and stops doing useful work until the
operator restarts it.

The cold worker is different: it runs as a separate child process supervised by the main
runtime and is restarted after unexpected exit.

> **Known limitation**: `worker_threads` share the main process. A V8 fatal error or OOM
> in the hot worker still takes the process down. If hot-worker restarts become a real
> operational need, move it behind explicit process supervision instead of adding brittle
> in-process restart loops.

### 2.5 Ingest Durability & Replay

Every fill is persisted to `fills` *before* dispatch for analysis. The ledger is
append-only for market data fields, with one operational exception: `analyzed` is
mutable replay state.

On restart:

1. Read last fill timestamp from `fills` (the checkpoint)
2. Request trades from Polymarket CLOB starting from that timestamp
3. Deduplicate via `(tx_hash, token_id)` unique constraint
4. Replay fills marked `analyzed = false`

The natural key was validated in Phase 0 and locked in [ADR 0001](../docs/adr/0001-phase0-fills-schema.md).

Current idempotency boundaries:

- LIVE signal persistence: `signal_events` is idempotent on `(fill_id, signal_id)`
- Promoted alerts: `alerts` is idempotent on `(fill_id, signal_id)`
- Channel delivery state: `alert_deliveries` stores per-channel outcomes
- Replay boundary: `fills.analyzed = true` only after hot-path work completes

Post-resolution idempotency remains a future design concern for the later retrospective
pipeline; it is not part of the current runtime contract.

### 2.6 Ingestion Mode

REST polling is **primary** in the current runtime. WebSocket capture exists in Phase 0
validation tooling, but `omen start` is intentionally correct in REST-only mode. If a WS
upgrade is added later, it must remain an optimization rather than a correctness
dependency.

### 2.7 Input Sanitization

All external text is treated as hostile. Per-surface sanitizers:

- **TUI**: never trust remote text to control terminal state; strip or neutralize control
  characters before rendering
- **Telegram**: escape HTML/Markdown injection
- **Discord**: escape Markdown, disable `@everyone`/`@here`
- **Logs**: pino safe serializers, max field length 1024
- **ACP (future)**: sanitize through explicit external DTOs (§8)

### 2.8 Graceful Shutdown

Shutdown ordering matters with multiple runtimes and connections:

1. Stop polling for new fills
2. Stop accepting new hot-worker work and drain in-flight analyses
3. Stop the supervised cold worker with a bounded timeout
4. Wait for pending alert-promotion/dispatch tasks
5. Close BullMQ queue handles
6. Restore TTY state if the dashboard is active
7. Close Redis and Postgres clients
8. Exit

ACP shutdown hooks belong here only once ACP exists in the runtime.

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
At scale, funding graph builds will bottleneck. The current implementation degrades by
cooling down rebuild attempts and continuing live scoring without fresh graph data. If
sustained throughput is needed, upgrade to a paid tier or add fallback infrastructure.

---

## 3. Tech Stack

### Runtime & Language

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Language          | TypeScript 5.x (strict) | Strong typing across threads, runtime schemas, and persistence |
| Runtime           | Node.js 22 LTS          | Stable worker threads, modern ESM support          |
| Package manager   | pnpm                    | Fast, deterministic dependency management          |
| Module system     | ESM                     | Matches the current repo and runtime entrypoints   |

### Data & Persistence

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Primary DB        | PostgreSQL 16           | Relational durability, numeric money fields, replay-safe ledger |
| DB access         | `pg` + explicit SQL     | Current repo uses hand-written DDL and query modules |
| Cache / queue infra | Redis 7 (`ioredis`)   | BullMQ backend, heartbeats, alert dedup            |
| Durable queue     | BullMQ                  | Separate-process cold-path jobs                    |

### Data Sources

| Source             | Protocol          | Purpose                                           |
| ------------------ | ----------------- | ------------------------------------------------- |
| Polymarket data API | REST             | Recent fills for the live detector                 |
| Polymarket Gamma   | REST              | Active-market metadata used by the market catalog  |
| Polymarket market WS | WebSocket       | Validation capture tooling today; possible runtime upgrade later |
| Alchemy RPC        | JSON-RPC          | Wallet age, tx count, contract detection, funding traces |
| Dune / other history providers | REST  | Future backfill/bootstrap work                     |

> **Funding trace scope**: Traces USDC *and* ETH/MATIC transfers. Insiders may fund via
> ETH, swap to USDC on-chain, then bet. The swap shows up in Polygon tx history.

### TUI

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Renderer          | Raw ANSI string renderer | Matches the current `src/tui/render.ts` implementation |
| Input handling    | `node:readline` keypress events | Minimal dependency surface, direct TTY control |
| Presentation mode | TUI or structured JSON logs | Same runtime can run interactively or headless     |

### ACP Integration

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Status            | Phase 3+ roadmap        | ACP is part of product direction, not current code |
| SDK/runtime choice | Intentionally not locked yet | Pin the concrete SDK when ACP work starts, not earlier |

### Quality & Tooling

| Concern           | Choice                  | Rationale                                          |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Testing           | Vitest                  | Current unit/integration suite                     |
| Schema validation | Zod                     | Runtime validation for config and external payloads |
| Logging           | pino                    | Structured JSON with low overhead                  |
| Config            | TOML + env overlays     | Versioned tuning with secrets in env               |
| Static checks     | `tsc --noEmit`          | Current typecheck contract                         |

---

## 4. Project Structure

```
omen-bot/
├── src/
│   ├── cli.ts                          # CLI entrypoint
│   ├── config/
│   │   ├── index.ts                    # TOML + env loader
│   │   ├── schema.ts                   # Zod config schemas
│   │   └── constants.ts                # Scoring version and shared constants
│   ├── engine/                         # Main runtime loop: ingest, replay, health
│   ├── hot-worker/                     # Worker-thread client + runtime
│   ├── cold-path/                      # BullMQ queue, worker runtime, supervisor
│   ├── ingestion/
│   │   └── polymarket-client.ts        # Live fill ingest source
│   ├── phase0/                         # Validation capture/analyze tooling
│   ├── profiling/                      # Wallet chain profiling against Alchemy
│   ├── markets/                        # Active market catalog cache
│   ├── signals/                        # Current live signal implementations + scoring
│   ├── clusters/                       # Funding-graph and clustering helpers
│   ├── persistence/
│   │   ├── db.ts                       # pg pool creation
│   │   ├── schema.ts                   # Runtime DDL
│   │   ├── redis.ts
│   │   └── queries/
│   │       ├── fills.ts
│   │       ├── wallets.ts
│   │       ├── alerts.ts
│   │       ├── signal-events.ts
│   │       └── funding-edges.ts
│   ├── alerts/                         # Promotion, dispatch, Telegram, Discord, dedup
│   ├── resilience/                     # Health reporting
│   ├── tui/                            # Terminal dashboard renderer
│   ├── logging/
│   ├── evm/
│   └── types/                          # Shared runtime types
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── docs/
│   └── adr/
├── tsconfig.json
├── package.json
├── .env.example
├── omen.config.toml
├── docker-compose.yml
└── README.md
```

Future directories such as `src/acp/` and `src/ontology/` belong to the roadmap in
later phases; they are intentionally not part of the current repo contract.

### 4.1 CLI Commands

Current CLI surface:

```bash
omen [--env-file .env] start [--tui]
omen [--env-file .env] replay
omen [--env-file .env] health
omen [--env-file .env] test-telegram
omen [--env-file .env] cold-worker

omen [--env-file .env.server] validate-fills capture \
  --hours 24 --out .phase0-data/run-001 [--use-auth] [--detach]
omen [--env-file .env.server] validate-fills analyze \
  --input .phase0-data/run-001
```

Behavioral notes:

- `start` runs the live detector and supervises the cold worker.
- `start --tui` enables the terminal dashboard; headless `start` emits structured logs.
- `replay` reprocesses persisted `fills` where `analyzed = false`.
- `health` reports service status plus runtime counters.
- `test-telegram` is an operational smoke test for Telegram formatting and delivery.
- `cold-worker` can be run standalone for debugging or separate process management.
- `validate-fills capture/analyze` is Phase 0 tooling for fill-ledger validation.

Future command families for ACP or ontology work should be added only when those features
exist in the repo; the spec should not treat roadmap commands as current CLI contract.

---

## 5. Domain Types

This section describes the **current runtime contract**. Later phases can extend these
types, but should not silently blur the distinction between current detector types and
future roadmap shapes.

### 5.1 Wallet Profile

```typescript
// src/types/wallet.ts

import type { AlertTier } from './signal.js';

export interface WalletProfile {
  address: string;
  ageSeconds: number;
  activityAgeKnown: boolean;
  totalTransactions: number;
  isContract: boolean;
  controllerAddress: string | null;
  firstSeenAt: Date;
  lastActiveAt: Date;
  totalMarkets: number;
  totalFills: number;
  totalVolumeUsd: string;
  liveSuspicionScore: number;
  liveTier: AlertTier;
  isWhitelisted: boolean;
}

export interface WalletChainProfile {
  ageSeconds: number;
  activityAgeKnown: boolean;
  totalTransactions: number;
  isContract: boolean;
  controllerAddress: string | null;
  firstActivityAt: Date | null;
}
```

Planned later phases may add richer retrospective metrics, category statistics,
resolution-derived performance, and funding-cluster context. Those fields are **future
extensions**, not part of the current runtime type contract.

### 5.2 Detection Signals

```typescript
// src/types/signal.ts

export type SignalAvailability = 'LIVE' | 'POST_RESOLUTION';
export type AlertTier = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAN';

export enum SignalId {
  FRESH_WALLET_LARGE_POSITION = 'FRESH_WALLET_LARGE_POSITION',
  OUTSIZED_POSITION = 'OUTSIZED_POSITION',
}

export interface SignalEvidence {
  field: string;
  value: string | number;
  threshold: string | number;
  description: string;
}

export interface TriggeredSignal {
  signalId: SignalId;
  availability: SignalAvailability;
  score: number;
  confidence: number;
  evidence: SignalEvidence[];
  triggeredAt: Date;
}
```

The broader signal matrix in later sections is the **planned detector roadmap**, not the
current enum or hot-path contract. New signals should land behind explicit versioning so
analytics history remains interpretable.

### 5.3 Fill & Market Types

```typescript
// src/types/market.ts

export interface MarketInfo {
  id: string;
  question: string;
  marketSlug: string | null;
  dailyVolumeUsd: string;
  volumeUsd: string;
  liquidityUsd: string;
}

// src/types/fill.ts

export type FillSide = 'BUY' | 'SELL';
export type FillOutcome = 'YES' | 'NO';
export type FillOrderType = 'TAKER' | 'MAKER' | 'UNKNOWN';

export interface NewFill {
  id: string;
  marketId: string;
  tokenId: string;
  walletAddress: string;
  side: FillSide;
  outcome: FillOutcome;
  price: string;
  shares: string;
  sizeUsd: string;
  txHash: string;
  orderType: FillOrderType;
  timestamp: Date;
}

export interface FillRecord extends NewFill {
  analyzed: boolean;
  createdAt: Date;
}
```

### 5.4 Thread Message Protocol

```typescript
// src/types/thread-messages.ts

export type EnqueueFillResult = 'accepted' | 'duplicate' | 'full';

export type MainToHotWorkerMessage =
  | { type: 'ANALYZE_FILL'; fill: FillRecord }
  | { type: 'STOP' };

export type HotWorkerToMainMessage =
  | {
      type: 'HEARTBEAT';
      at: string;
      queueDepth: number;
      processing: boolean;
      lastProcessedAt: string | null;
    }
  | {
      type: 'ENQUEUE_RESULT';
      fillId: string;
      result: EnqueueFillResult;
    }
  | {
      type: 'FILL_RESULT';
      fillId: string;
      status: 'processed' | 'failed';
      error: string | null;
    }
  | ({ type: 'SIGNAL_PREVIEW' } & SignalPreview)
  | {
      type: 'ERROR';
      error: string;
      fillId: string | null;
    };
```

The hot-path contract is intentionally narrow: enqueue fills, observe worker health, and
receive persisted signal previews. Market scans, wallet profile RPCs, and ontology
queries do **not** belong on this boundary today.

---

## 6. Detection Engine

### 6.1 Current Scoring Model

The current runtime computes **one live score** per wallet from LIVE hot-path signals.
That score is clamped to `[0, 100]` and mapped to `CRITICAL | HIGH | MEDIUM | LOW | CLEAN`
using operator-configured thresholds.

Future phases may add a separate retrospective score derived from market outcomes, but
that should remain a second score rather than silently contaminating the live one with
look-ahead data.

Current gating rules:

- Whitelisted wallets are excluded from live signal evaluation.
- Contract wallets are excluded from fresh-wallet scoring until controller attribution
  exists.
- If wallet activity age cannot be established reliably, `FRESH_WALLET_LARGE_POSITION`
  does not fire.

### 6.2 Current Score Constants and Thresholds

```typescript
export const CURRENT_SIGNAL_SCORES = {
  FRESH_WALLET_LARGE_POSITION: {
    critical: 30,
    elevated: 18,
  },
  OUTSIZED_POSITION: 12,
} as const;

export const CURRENT_TIER_THRESHOLDS = {
  CRITICAL: 80,
  HIGH: 60,
  MEDIUM: 40,
  LOW: 20,
  CLEAN: 0,
} as const;

export const SCORING_VERSION = 'phase1-v1';
```

Operator-tunable thresholds live in `omen.config.toml`. Signal additions or score-weight
changes must advance `SCORING_VERSION` deliberately so persisted analytics remain
comparable across releases.

### 6.3 Current Signal Implementations

**FRESH_WALLET_LARGE_POSITION**

This is the current high-confidence live signal. It fires only when all of the following
are true:

- `wallet.activityAgeKnown === true`
- `wallet.ageSeconds < elevatedAgeHours`
- `wallet.totalTransactions <= maxTxns`
- `market.dailyVolumeUsd < nicheMaxVolume`
- `fill.sizeUsd >= max(largePositionMinUsd, market.dailyVolumeUsd * largePositionVolumePct)`

Severity is two-tiered:

- `< criticalAgeHours` → score `30`, confidence `0.95`
- `< elevatedAgeHours` → score `18`, confidence `0.80`

Conservative contract-wallet behavior matters here: the current runtime simply skips this
signal for contract wallets because controller attribution is not yet implemented.

**OUTSIZED_POSITION**

This is the current context signal for market-relative notional size. It fires when:

```text
fill.sizeUsd >= max(largePositionMinUsd, market.dailyVolumeUsd * largePositionVolumePct)
```

Current output is fixed:

- score `12`
- confidence `0.80`

It has no freshness requirement and no niche-market cap. It is meant to surface unusually
large single entries even from older wallets.

**Cold-path enrichment**

The current cold path builds funding graphs and cluster assignments, but those results do
not yet produce a dedicated live `SYBIL_CLUSTER` signal in the runtime. That remains a
Phase 2 detector expansion, not a current hot-path contract.

### 6.4 Engine Operational Patterns

**Wallet stub upsert**

On first fill encounter the system upserts a minimal wallet row and then computes the
rest of the live profile in the hot worker.

**Aggregate stats are derived from the fills ledger**

Current wallet aggregates such as `totalFills`, `totalMarkets`, and `totalVolumeUsd` are
derived from `fills`, not maintained as a separate source of truth.

**Chain profiling is cache-first**

Wallet age, transaction count, and contract detection come from the Alchemy-backed wallet
profiler with an in-memory TTL cache in the hot worker.

**Market metadata is cached**

The active market catalog refreshes from Gamma on a short TTL and feeds the hot worker
with `question`, `marketSlug`, `dailyVolumeUsd`, `volumeUsd`, and `liquidityUsd`.

**Replay boundary**

`fills.analyzed` flips only after hot-path work completes. That flag means “the hot
worker has finished this fill,” not “all future downstream analytics are complete.”

**Future retrospective path**

Resolution-aware scoring, statistical tests on resolved outcomes, timing-to-resolution
signals, and richer cluster/cross-market features remain part of the roadmap, not the
current engine contract.

---

## 7. Resilience

### 7.1 Current Resilience Primitives

The current runtime relies on a few explicit primitives rather than a generic
circuit-breaker framework:

- replayable fill persistence before analysis
- hot-worker heartbeat reporting
- cold-worker process supervision
- conservative signal suppression when chain profiling is incomplete
- structured health checks over every external dependency

### 7.2 Alert Deduplication

Dedup is channel-scoped and market-scoped:

```text
omen:dedup:{channel}:{marketId}:{walletAddress}:{signalId}
```

This prevents Telegram and Discord from suppressing each other and prevents one market’s
alert from suppressing another. The current implementation uses a fixed cooldown window;
there is **no score-increase override** in the runtime today.

### 7.3 Backpressure

Hot-worker enqueue is bounded (default depth `100`, configurable). When full:

- enqueue returns `full`
- the fill remains `analyzed = false`
- replay/backlog processing is expected to recover it later

The system does **not** drop the oldest queued fill in the current implementation.

### 7.4 Health Checks

`omen health` currently reports:

- `postgres`
- `redis`
- `polymarketRest`
- `alchemyRpc`
- `hotWorker`
- `coldWorker`

It also returns runtime counters such as queue depth, pending fill count, last processed
timestamp, unanalyzed fill count, newest fill timestamp, recent signal count, recent
alert count, and cold-path BullMQ queue stats.

---

## 8. ACP Integration

ACP remains a **Phase 3+ product direction**, not a current runtime surface. This
section captures the intended design boundaries so later implementation stays compatible
with the detector architecture.

### 8.1 Design Principles

- ACP must stay outside the hot path. It can trigger scans, lookups, and subscriptions,
  but it must not sit in the latency-sensitive trade-analysis loop.
- All buyer-facing responses must go through explicit DTOs rather than raw database rows.
- Long-running ACP workflows such as watchlists need durable state and resumable delivery.
- Pricing, packaging, and provider-specific SDK details are operational concerns and
  should not be hard-coded into the core technical reference before implementation.

### 8.2 Likely Offerings

The likely Phase 3 offering families remain:

- one-shot market insider scan
- one-shot wallet suspicion score
- one-shot cluster analysis
- market watchlist / subscription monitoring

Depth tiers such as `quick`, `standard`, and `deep` are still a sensible model, but the
exact SLA and pricing schedule should live with the ACP implementation, not as frozen
values in the pre-implementation spec.

### 8.3 Watchlist Lifecycle

If/when watchlists are built, the lifecycle should remain explicit and durable:

```text
FUNDED -> ACTIVE -> COMPLETED | CANCELLED | EXPIRED
```

Terminal reports should include either the observed anomalies and evidence or an explicit
clean-result statement. “No anomalies found” is a valid successful delivery.

### 8.4 Tenant Boundary and Abuse Controls

ACP responses must:

- exclude internal-only fields such as notes, labels, or operator trust annotations
- sanitize all outbound text
- scope all artifacts to the buyer/job context

Expected abuse controls include:

- per-buyer concurrency limits
- coalescing identical near-term requests
- load shedding when deep analysis would starve core detector operations
- caps on active subscriptions per buyer and globally

---

## 9. TUI Design

### 9.1 Phase 1 Layout (MVP — 2 panels)

```
┌─ OMEN Phase 1 Dashboard ────────────────────────────────────────────────┐
│                                                                         │
│  [HIGH] 12:31:22 OUTSIZED_POSITION                                      │
│  0x7a3...f91 | score 42 | fill $15000                                   │
│  Will candidate X resign before June?                                   │
│                                                                         │
│  [LOW] 12:28:10 FRESH_WALLET_LARGE_POSITION                             │
│  0xabc...123 | score 30 | fill $2500                                    │
│  Will proposal Y pass?                                                  │
│                                                                         │
│  State:RUNNING | REST:UP | Hot:IDLE | Cold:IDLE | Mkts:12 | Wallets:44 │
│  [q]Quit [?]Help [t]TierFilter [d]DryRun [Esc]Reset                     │
└─────────────────────────────────────────────────────────────────────────┘
```

The current implementation is a raw terminal dashboard rendered from `src/tui/render.ts`.
It ships with **alert feed + status bar + help overlay behavior**, not a multi-panel Ink
application. The important product requirement is still the same: the operator should be
able to see promoted alerts, runtime health, and dry-run state at a glance.

### 9.2 Visual Hierarchy

Strict visual discipline still matters even in a raw terminal renderer:

- **CRITICAL**: Red text + inverted background tag. Demands eye contact.
- **HIGH**: Amber/yellow text.
- **MEDIUM**: Blue text.
- **LOW**: Dim gray. Recedes into background.
- **CLEAN**: Not rendered in alert feed.

If everything is bright, nothing is. Let high-signal alerts punch through the noise.

### 9.3 Keybinds

| Key    | Action                                      |
| ------ | ------------------------------------------- |
| `t`    | Toggle alert tier filter                     |
| `d`    | Toggle dry-run mode                          |
| `Esc`  | Clear search/filter, reset focus to default  |
| `?`    | Help overlay                                 |
| `q`    | Quit                                         |

Additional investigation controls such as focused market/wallet inspection belong to a
future TUI or web workflow rather than the current Phase 1 dashboard contract.

### 9.4 Progressive Disclosure (Phase 2)

Any future cluster map or wallet inspector should render compact summaries first and only
expand large graphs or evidence bundles on explicit operator action.

Empty/loading states matter: before trades flow, show `Listening to Polymarket...` with
connection indicators rather than a blank screen.

---

## 10. Database Schema

All money, price, share, and score-adjacent numeric fields should use `numeric(...)` or
`double precision` as appropriate. `real` is not acceptable for financial data.

### 10.1 Current Runtime Tables

The current runtime schema in `src/persistence/schema.ts` is:

- **`fills`** — live fill ledger. `id` is application-generated; uniqueness is enforced on
  `(tx_hash, token_id)`. All market data fields are append-only; `analyzed` is mutable
  operational state for replay.
- **`wallets`** — derived wallet state. The hot path actively uses age, activity-known,
  tx count, contract/controller metadata, aggregate Polymarket stats, live score/tier,
  funding-cluster metadata, and whitelist status. The schema also already carries
  retrospective/operator fields (`wins`, `win_rate`, `total_pnl_usd`, `labels`, `notes`,
  etc.) that are not yet part of the live detector contract.
- **`funding_edges`** — cold-path funding graph edges keyed to a root wallet.
- **`signal_events`** — append-only persisted live signal firings, idempotent on
  `(fill_id, signal_id)`. The schema also already includes a future-oriented fill-less
  idempotency index for retrospective/post-resolution events.
- **`alerts`** — promoted operator alerts, idempotent on `(fill_id, signal_id)`.
- **`alert_deliveries`** — per-channel dispatch outcomes and retry history.
- **`whale_whitelist`** — operator-maintained allowlist for legitimate large traders.

### 10.2 Future Detector Tables

The following tables are still valid later-phase design targets, but they are **not**
part of the current runtime schema contract today:

- `markets`
- `wallet_snapshots`
- `subscriptions`
- `audit_log`
- `ingest_quarantine`

Each should be added only alongside the feature that actually uses it. The spec should
not present dormant tables as if they were already authoritative runtime state.

### 10.3 Ontology Tables (Phase 5+)

The Phase 5 ontology can still fit personal scale on PostgreSQL, but the schema needs
explicit identity and idempotency boundaries:

**`entities`**

- one row per resolved entity
- must include a stable identity key such as `entity_key` or equivalent connector-safe
  canonical key
- `display_name`/`name` is presentation data, not identity
- may optionally soft-link back to detector tables via `domain_ref` + `domain_type`

**`relationships`**

- one row per typed assertion between two resolved entities
- should be treated as an **aggregated assertion** with provenance and confidence, not as
  a one-off observation log
- if multiple connector observations support the same edge, update provenance and
  `last_seen` rather than creating duplicate semantic edges

**`raw_events`**

- immutable connector input log
- must include a connector-scoped external event key or dedup key
- should be unique on `(connector, external_event_key)` or equivalent
- exists to preserve provenance and enable replay/debugging

The three-table model is sufficient at personal scale **only if** those identity and
dedup rules are explicit. If merge complexity grows later, add observation tables rather
than overloading `sources` JSON arrays indefinitely.

### 10.4 Retention

Retention windows should be introduced together with the cleanup jobs that enforce them.
Do not pre-seed retention config for tables or workflows that do not yet exist.

---

## 11. Configuration

> **Config management**: use **TOML** (`omen.config.toml`) for current tuning parameters
> and environment variables for secrets / deployment-specific values. The current repo
> does **not** expose `omen config show` / `omen config validate` commands yet; the
> authoritative contract today is the loader in `src/config/index.ts` plus the Zod
> schemas in `src/config/schema.ts`.
>
> The checked-in TOML currently seeds only the knobs being actively tuned. The schema
> supplies defaults for additional reserved detector settings, so the repo's supported
> config surface is slightly broader than the literal sample file.

```bash
# .env.example — deployment-specific values and secrets.
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

# Logging
LOG_LEVEL=info
LOG_PRETTY=true

# Phase 0 / optional Polymarket auth
POLY_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
# POLY_SIGNATURE_TYPE=2
# POLY_FUNDER=0xYOUR_POLYMARKET_FUNDER_ADDRESS
# POLY_API_KEY=
# POLY_API_SECRET=
# POLY_API_PASSPHRASE=
```

```toml
# omen.config.toml — current checked-in versioned tuning values.
# Override supported values via env vars where implemented.

[ingestion]
poll_interval_ms = 15_000
max_pages_per_poll = 20

[detection.fresh_wallet]
critical_age_hours = 24
elevated_age_hours = 72
max_txns = 10

[detection.market]
niche_max_volume = 100_000
large_position_min_usd = 1_000
large_position_volume_pct = 0.02

[alerts]
critical_min_score = 80
high_min_score = 60
medium_min_score = 40
low_min_score = 20
dedup_cooldown_ms = 86_400_000

[operational]
dry_run = false

[backpressure]
hot_worker_queue_depth = 100

[cold_path]
concurrency = 1
rebuild_failure_cooldown_ms = 900000
shutdown_timeout_ms = 30000
```

Current config nuances:

- `OMEN_POSTGRES_PORT` and `OMEN_REDIS_PORT` are local compose/dev convenience values, not
  keys consumed directly by the app config loader.
- `detection.cluster` is already part of the schema defaults and affects cold-path
  funding-graph rebuild behavior even when omitted from the checked-in TOML.
- `detection.niche_market_entry`, `detection.conviction_size_mismatch`, and
  `detection.lump_entry` already exist in the schema as reserved knobs, but they are not
  consumed by the current live detector.
- Env overrides currently exist only for ingestion, dry-run, backpressure, and cold-path
  settings; detection thresholds remain TOML-backed today.

Future knobs for ACP, ontology, retention, or additional signal families should be added
only when the corresponding feature exists or is genuinely wired into the runtime.

---

## 12. Coding Standards

- **TypeScript strict mode** (`strict: true`, `noUncheckedIndexedAccess: true`)
- **No `any`** — `unknown` + narrowing or Zod
- **Runtime validation at boundaries** — external payloads and config pass through Zod
- **Prefer explicit persistence modules** — schema and query logic live in focused files
- **Stateful resource wrappers are acceptable** for workers, dispatchers, and supervisors
- **Naming**: camelCase vars/functions, PascalCase types, UPPER_SNAKE constants, kebab files
- **Dependency injection via parameters** — keep external clients explicit where practical
- **Side effects isolated** to runtime entrypoints and resource-owning classes/functions
- **Thread boundary explicit**: typed MessagePort, no shared mutable state
- **Tests must prove replay/idempotency behavior** where persistence is the correctness boundary
- **Spec examples must distinguish current contract vs roadmap** instead of collapsing them together

---

## 13. Implementation Phases

### Phase 0 — Validation Gate

Purpose: lock the fill-ledger semantics before higher-level analytics depend on them.

- Capture representative public and optional authenticated trade traffic
- Re-validate the natural key if upstream payloads materially change
- Keep the capture/analyze tooling healthy so schema assumptions can be re-proven
- Maintain the ADR trail for ledger-shaping decisions

Current reference decision: the fills natural key is `(tx_hash, token_id)` per ADR 0001.

### Phase 1 — Thin-Slice Detector

Purpose: real-time Polymarket monitoring with a minimal but correct operational surface.

- REST ingest, replay-safe `fills` ledger, and hot-worker scoring
- Current live wallet profiling via Alchemy
- Promoted operator alerts with Telegram/Discord dispatch
- Terminal dashboard plus structured headless logs
- Funding-graph rebuilds in a separate cold-path process
- Health reporting, dry-run mode, and operator-grade restart/replay behavior

### Phase 2 — Deepen the Detector

Purpose: expand detection quality without destabilizing the thin slice.

- Add more live signals where they are empirically justified
- Add post-resolution and retrospective analytics
- Deepen funding-graph and cluster analysis
- Add wallet snapshots, richer investigation surfaces, and backtesting/calibration
- Optionally add WS ingest for lower latency while preserving REST correctness
- Begin Kalshi raw data collection if cross-venue work remains a priority

> **Phase 3 gate**: ACP monetization begins only after Phase 2 backtests demonstrate real
> detection signal on labeled insider cases. If backtests do not validate, iterate on the
> detector before adding commerce complexity.

### Phase 3 — ACP Product Layer

Purpose: sell the detector as an intelligence service without contaminating the core
runtime.

- one-shot market, wallet, and cluster offerings
- explicit external DTOs and tenant boundaries
- watchlist lifecycle and durable subscription state
- griefing protection, quotas, request coalescing, and load shedding
- cleanup jobs and operational hardening for longer-lived workloads

### Phase 4 — Cross-Market and Calibration

Purpose: improve signal quality through more context, more history, and better
normalization.

- cross-market correlation and information-source classification
- Dune/backfill workflows where historical corpus materially improves detection
- Kalshi cross-venue analysis if the data corpus justifies it
- evaluate candidate signals such as `POSITION_FLIP`
- choose between raw-edge and normalized-edge models using real backtests

### Phase 5 — Entity Ontology + Identity Attribution

Purpose: introduce a shared investigative graph without changing the hot path.

- add ontology tables with stable entity keys and connector-scoped raw-event dedup
- project existing detector data into the ontology from cold-path jobs
- add graph query and investigation workflows
- add identity enrichment connectors conservatively, with confidence-scored candidate
  associations rather than reckless hard identity claims
- add operator-facing entity inspection surfaces only after the underlying confidence and
  provenance model is defensible

**Key principle**: the hot path never queries ontology tables. The ontology is a
cold-path enrichment layer. The prediction-market module continues to use its domain
tables for all real-time scoring. The ontology answers investigative questions, not
real-time detection questions.

### Phase 6 — Event Correlation + Expanded Investigation UX

Purpose: connect suspicious market activity to real-world context.

- reactive event enrichment for high-confidence insider alerts
- pluggable news/search and public-calendar connectors
- stronger cross-source entity resolution
- additional connector families only when they unblock real investigations
- richer operator UX, potentially including a web dashboard

---

## 14. Open Questions

1. **Legal/reputational framing** — The system is positioned as market-integrity
   intelligence, not copy-trade tooling. Get legal review before public ACP
   commercialization.

2. **Polymarket API stability** — REST-primary mitigates WS fragility, but the long-term
   fallback story for historical gaps and schema changes still needs operational thought.

3. **Proxy wallet attribution** — Contract detection exists; controller attribution does
   not. The right default remains conservative false negatives rather than false-positive
   insider accusations.

4. **Kalshi prioritization** — Cross-venue correlation may be high value, but only if the
   normalization and historical-corpus cost is justified by actual investigative payoff.

5. **ACP gating** — Multiple reviewers flagged that ACP adds lifecycle/state complexity
   before the core detector is proven. Keep monetization gated behind demonstrated signal
   quality.

6. **Ontology identity model** — The graph must define what constitutes a stable entity,
   how merges happen, and which keys are authoritative. `name` is not enough.

7. **Identity confidence semantics** — ENS names, social handles, profile metadata, and
   other weak signals should produce candidate associations with provenance, not instant
   hard person-level claims.

8. **Ontology domain-ref integrity** — `domain_ref`/`domain_type` should remain soft
   links. The application must handle stale detector-side references without pretending
   ontology rows are foreign-key-clean.

9. **Cross-domain query performance** — PostgreSQL recursive queries are fine at personal
   scale, but if the graph grows materially, adjacency strategies or graph extensions may
   become worth evaluating.

10. **Connector prioritization** — Build connectors when they unblock real investigations,
    not because the ontology invites speculative data hoarding.

11. **Event-source provider choice** — Keep event enrichment provider-agnostic. RSS,
    public calendars, and pluggable search/news providers are safer than hard-coding one
    brittle vendor into the architecture.

---

## 15. Platform Evolution: Entity Ontology

This section describes the long-term architecture that transforms Omen from a prediction
market tool into a personal intelligence platform. **Nothing in this section changes the
current implementation plan (Phases 0-4).** The ontology is introduced in Phase 5, after
the prediction market module is proven and monetized.

### 15.1 Core Principle

Borrowed from Palantir: **the ontology is the long-term product surface.** Connectors
bring in evidence; views and queries turn that evidence into operator understanding.

In Omen, this is a **direction**, not a claim that the current detector already runs on
ontology entities. The present system is intentionally domain-table-first. The ontology
exists to compound value across domains later without dragging that complexity into the
hot path.

### 15.2 Dual-Layer Architecture

The system maintains **two persistence layers** that coexist:

**Domain tables** (fills, wallets, funding_edges, signal_events, alerts, etc.) — the
"fast path." High-volume, module-specific, structured schema. Used by the hot path worker
for real-time scoring and by the surrounding runtime for promotion, dispatch, replay, and
investigation support. These tables are optimized for the prediction-market module's
specific workload: indexed fills, typed wallet profiles, funding traces, and normalized
signal events.

**Ontology tables** (entities, relationships, raw_events) — the "integration path."
Semi-structured, cross-domain, queryable by any module. Used by cold-path enrichment jobs
and investigative queries. Adding a new entity type requires zero migrations — just insert
a row with a new `type` value.

The hot path **never queries ontology tables**. The ontology is populated by cold-path
BullMQ jobs that read from domain tables and write entities. This ensures the real-time
detection engine is never slowed by cross-domain query overhead.

### 15.3 The Connector Pattern

Not every connector does the same job. Omen needs **three connector shapes**:

```typescript
interface SourceConnector {
  id: string;
  ingest(): AsyncIterable<RawEvent>;
  map(rawEvent: RawEvent): ConnectorProjection;
}

interface Projector {
  id: string;
  project(): AsyncIterable<ConnectorProjection>;
}

interface Enricher {
  id: string;
  enrich(seed: SeedEntity): AsyncIterable<ConnectorProjection>;
}
```

- **Source connectors** pull external feeds and should write `raw_events` with a
  connector-scoped dedup key before projecting entities/relationships.
- **Projectors** read existing domain tables and project them into the ontology. The
  Polymarket ontology migration belongs here, not in a generic external-ingest model.
- **Enrichers** start from an existing seed entity (for example a wallet) and perform
  targeted lookups such as ENS or profile enrichment.

This avoids forcing radically different workflows into one `ingest() + mapToEntities()`
shape.

### 15.4 Cross-Domain Enrichment: Two Use Cases

**Use Case 1: "What do the insiders know?" — Event ↔ Insider Correlation**

When a high-confidence insider signal fires, the system automatically searches for related
real-world events. Not continuous monitoring — reactive enrichment, triggered only by
CRITICAL/HIGH alerts (low frequency, minimal API cost).

Sources queried on signal fire:
- RSS and pluggable news/search providers for the market's subject
- Government press schedules and public calendars
- Relevant social/account activity where the provider access is operationally justified
- Other prediction markets showing simultaneous anomalous activity on related topics

Output: the alert is enriched with "here's what the insiders might know" context.
A prediction market insider alert with a probable catalyst is 10x more actionable than
one without.

**Use Case 2: "Who is this wallet?" — Wallet ↔ Identity Attribution**

When a wallet is flagged, the system cross-references identity-adjacent sources to
produce **candidate associations**, not instant real-world identity claims.

Sources queried on wallet flag:
- ENS and similar naming layers
- profile/account metadata from platforms that expose wallet-linked identities
- GitHub or deployment metadata where wallet attribution is first-party or strongly implied
- WHOIS or other open-source references when they materially improve an investigation

Output: the wallet profile is enriched with confidence-scored candidate associations and
supporting provenance. ENS by itself should create a naming alias, not a strong `person`
entity claim. Social/profile evidence should strengthen confidence only when corroborated.

### 15.5 Entity Graph Schema Design

The ontology uses three tables (defined in §10):

**`entities`** — universal entity store. Each row is a typed entity (wallet, person,
market, domain, event, etc.) with JSONB properties and provenance tracking. It must have
a stable identity key in addition to display data. The `domain_ref`/`domain_type` fields
link back to module-specific tables when applicable.

**`relationships`** — typed edges between entities. Each relationship is an aggregated
assertion with confidence and provenance. The row should answer “what do we currently
believe about this edge and why?”, not merely “did we see one raw observation once?”.

**`raw_events`** — immutable provenance trail. Every external source connector writes raw
events before mapping to entities, preserving the exact data received for audit and
replay. This table needs a connector-scoped dedup/external-event key to be safe.

### 15.6 What This Enables Over Time

The entity graph is **additive, not rewrite**. Each connector enriches the graph without
changing existing data. The investment compounds:

- Polymarket connector alone → useful wallet intelligence
- Add ENS connector → wallet profiles now have aliases and naming context
- Add social/profile connectors → aliases gain candidate affiliations and stronger context
- Add news connector → alerts have real-world context
- Add cyber connector → wallet owners' infrastructure is mapped

Each new source creates multiplicative cross-domain connections. The graph gets
exponentially more valuable with each connector, not linearly.

### 15.7 Architecture Awareness in Current Implementation

While building Phases 0-4, keep these design decisions in mind. They don't require
extra code now, but they make the Phase 5 ontology migration smooth:

1. **Omen's wallet profiles are future entities.** The `wallets` table maps cleanly to
   `entities` with `type: 'wallet'`. Keep the wallet profile clean and self-contained.

2. **Cluster membership is a future relationship.** Funding edges and cluster membership
   map to `relationships` with `type: 'funded_by'` and `type: 'cluster_member'`.

3. **Not every integration is the same connector shape.** Some are source connectors,
   some are projectors from detector tables, and some are seed-entity enrichers.

4. **Signal events are entity-adjacent, not yet ontology-native.** They reference
   `walletAddress` + `marketId`; later ontology work should map those consistently
   without forcing the hot path to adopt ontology IDs.

No premature abstraction. Build the prediction market module. Feel the real pain points.
Abstract into the ontology when a second domain (identity, events) justifies it.

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| **v2.0** | 2026-04-01 | **Platform evolution.** Omen is reframed from a single-module insider detector to a personal intelligence platform with prediction markets as the first concrete module. |
| | | **Reference alignment**: Core runtime, CLI, config, persistence, type, TUI, and resilience sections were rewritten to match the current repo instead of an end-state architecture. |
| | | **Ontology tightened**: The entity graph remains the Phase 5+ direction, but now has explicit identity/dedup guardrails (`entity_key` / connector-scoped raw-event keys) and a clearer split between source connectors, projectors, and enrichers. |
| | | **Identity claims made conservative**: ENS/social/profile lookups are framed as confidence-scored candidate associations with provenance, not automatic hard real-world identity claims. |
| | | **ACP made roadmap-scoped**: ACP stays in the spec as a product direction, but concrete SDK/runtime and pricing details are no longer treated as current implementation facts. |
| | | **Phases/Open Questions updated**: The roadmap now reflects the current thin-slice detector, the Phase 0 ADR decision, and the real unresolved questions around attribution, ontology semantics, provider choice, and commercialization gates. |
| **v1.8** | 2026-03-27 | ACP prices raised ($25/$50/$75, watchlist $50-$200). CLI process ownership clarified. `omen config show` redacts secrets. `scoring_version` removed from TOML. `audit_log` + `ingest_quarantine` tables. |
| **v1.7** | 2026-03-27 | CLI commands. TOML config (secrets-only `.env`). `fills.analyzed` clarification. Idempotency integration test requirement. |
| **v1.6** | 2026-03-27 | Phase 0 validation spike. Time estimates removed. Phase 1 cut order + observability. Idempotency split (LIVE vs POST_RESOLUTION keys). Normalized edge as parallel experiment. Kalshi Phase 2 tightened. |
| **v1.5** | 2026-03-27 | Market difficulty normalization. POSITION_FLIP signal candidate. `scoringVersion` on signal_events/alerts/snapshots. Exactly-once idempotency. Graceful shutdown. Autovacuum config. Worker OOM limitation. Structured config recommendation. Kalshi Phase 2 early data. Phase 3 ACP gate. Proxy audit logging. |
| **v1.4** | 2026-03-27 | Hot/cold path split. Fills as immutable ledger. `real`→`numeric`. Dual live/retrospective scoring. Signal availability tags. Proxy detection. Whale whitelist. `signal_events` + `subscriptions` + `whale_whitelist` tables. ACP prices raised, DTOs, griefing protection. TUI simplified. Copy-trade dropped. Input sanitization. Market-scoped dedup. |
| **v1.3** | 2026-03-27 | T-test calibration (MIN_RESOLVED 5→8). Scan depth tiers. Thread requestId. Wallet stub shape. edgeAtEntry flow. Orderbook cold-start. Trades unique index fix. Watchlist validation. |
| **v1.2** | 2026-03-27 | Binomial → t-test. avgEdgeAtEntry includes losers. Watchlist lifecycle. TIMING_CLUSTER_BURST social suppression. Worker DB isolation + heartbeat. Data retention. FK removal. Dedup write fix. |
| **v1.1** | 2026-03-27 | Renamed HAWKEYE → Omen. Worker threads. Funding trace scalability. Ink 5 TUI. Edge-adjusted stats. Resolution-type timing. 2 new signals. Snapshots. Dedup. Resilience. market_watchlist. DRY_RUN. |
| **v1.0** | 2026-03-27 | Initial spec (as HAWKEYE). 14 signals, Polymarket focus, PG + Redis, TUI, alerts, Virtuals ACP. |
