# Omen Bot

Thin-slice Phase 1 Polymarket ingest and live-signal bot.

Current state:
- Persists live Polymarket fills into Postgres
- Dedupes fills on `(tx_hash, token_id)`
- Replays pending `analyzed = false` fills through a hot worker
- Profiles wallets on the hot path with Alchemy-backed Polygon RPC calls
- Persists LIVE `signal_events`
- Emits `signal-preview` JSON lines during `start` and `replay`
- Promotes LOW+ signal combinations into operator alerts
- Supports Telegram dispatch with market-scoped dedup
- Supports a Phase 1 terminal dashboard via `start --tui`
- Exposes `start`, `replay`, `health`, and Phase 0 validation commands

Current LIVE signals:
- `FRESH_WALLET_LARGE_POSITION`
- `OUTSIZED_POSITION`

Not built yet:
- Controller/proxy attribution for contract wallets
- Cold-path cluster / post-resolution scoring work

Specs:
- [specs/OMEN-SPEC-v1.8.md](specs/OMEN-SPEC-v1.8.md)
- [specs/OMEN-SPEC-v1.3-Legacy.md](specs/OMEN-SPEC-v1.3-Legacy.md)

## Quick Start

Requirements:
- Node.js 22+
- `pnpm`
- Docker / Docker Compose
- `ALCHEMY_API_KEY` for the hot worker
- Optional Telegram bot token + chat ids for operator alerts

Install and boot local dependencies:

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm exec tsx src/cli.ts health
```

The example env uses non-default local ports to avoid host collisions:
- Postgres: `localhost:15432`
- Redis: `localhost:16379`

Important health behavior:
- Before `start` or `replay` is running, `health` may report `hotWorker` as degraded because there is no active heartbeat yet.
- While `start` or `replay` is running, `health` should return overall `"status": "ok"` and include a populated `runtime` section.

Start the ingest loop:

```bash
pnpm exec tsx src/cli.ts start
```

Start the terminal dashboard:

```bash
pnpm exec tsx src/cli.ts start --tui
```

## What The Commands Mean

`start`
- Polls Polymarket REST for recent fills
- Inserts new fills into Postgres
- Queues pending fills into the hot worker
- Evaluates LIVE signals
- Writes `signal_events`
- Emits `signal-preview` diagnostics for every persisted LIVE signal event
- Promotes LOW+ composite scores into operator alerts
- Optionally dispatches Telegram alerts when configured and not in dry-run
- Marks fills `analyzed = true` only after hot-path work completes

`replay`
- Reprocesses already-persisted fills where `analyzed = false`
- Useful after crashes, worker failures, or code fixes
- Re-emits `signal-preview` diagnostics and can dispatch any still-unsent operator alerts
- `{"type":"replay","replayed":0}` means there was no pending hot-path backlog

`health`
- Checks Postgres, Redis, Polymarket REST, and the hot-worker heartbeat
- Also reports runtime state such as queue depth, pending fill count, newest fill timestamp, and recent live signal count

## What To Expect From `start`

You will see JSON lines like:

```json
{"type":"ingest-cycle","checkpoint":"2026-03-31T01:53:07.000Z","fetched":566,"inserted":566,"replayed":101}
{"type":"signal-preview","fillId":"...","walletAddress":"0x...","marketId":"0x...","marketQuestion":"...","walletLiveScore":12,"walletLiveTier":"CLEAN","signal":{"signalId":"OUTSIZED_POSITION","availability":"LIVE","score":12,"confidence":0.8,"evidence":[...],"triggeredAt":"2026-03-31T01:59:11.495Z"},"dryRun":false}
{"type":"runtime-stats","collectedAt":"2026-03-31T02:00:00.000Z","windowSeconds":60,"ingest":{"cycles":4,"fetched":12,"inserted":12,"replayAccepted":12},"hotWorker":{"enqueueAccepted":12,"enqueueDuplicate":0,"enqueueFull":0,"processed":12,"failed":0,"queueDepth":0,"pendingFillCount":0,"processing":false,"lastHeartbeatAt":"2026-03-31T01:59:59.991Z","lastProcessedAt":"2026-03-31T01:59:57.012Z","lastProcessedAgeMs":2988},"signals":{"previewCountsBySignalId":{"OUTSIZED_POSITION":3}}}
```

Interpretation:
- `fetched`: trades pulled from Polymarket in that cycle
- `inserted`: new fills written to Postgres
- `replayed`: pending fills the worker accepted for hot-path analysis in that cycle
- `signal-preview`: a LIVE signal fired for that fill and was persisted
- `runtime-stats`: one-minute aggregate counters for ingest, worker throughput, backpressure, and signal volume

Important distinction:
- `signal-preview` is a diagnostic stream for every persisted LIVE signal event, including `CLEAN` outcomes
- Telegram and the TUI alert feed only show promoted operator alerts where the wallet live tier is `LOW` or above
- `OUTSIZED_POSITION` by itself often stays diagnostic-only under the default score thresholds, which is expected

Practical expectations:
- The first run may backfill hundreds of fills.
- `OUTSIZED_POSITION` should fire on real traffic now.
- `FRESH_WALLET_LARGE_POSITION` may remain sparse because many live `proxyWallet` addresses are contracts and controller attribution is not implemented yet.
- `start --tui` suppresses the headless JSON stream and renders a live dashboard instead.

## Useful Checks

Health while running:

```bash
pnpm exec tsx src/cli.ts health
```

Check fill backlog:

```bash
docker compose exec postgres psql -U omen -d omen -c "select count(*) filter (where analyzed = false) as unanalyzed from fills;"
```

Inspect recent fills:

```bash
docker compose exec postgres psql -U omen -d omen -c "select tx_hash, token_id, wallet_address, side, outcome, price, shares, size_usd, timestamp, analyzed from fills order by timestamp desc limit 10;"
```

Inspect recent wallet profiles:

```bash
docker compose exec postgres psql -U omen -d omen -c "select address, age_seconds, total_transactions, is_contract, live_suspicion_score, live_tier, updated_at from wallets order by updated_at desc limit 10;"
```

Inspect recent signal events:

```bash
docker compose exec postgres psql -U omen -d omen -c "select signal_id, wallet_address, market_id, score, confidence, created_at from signal_events order by created_at desc limit 20;"
```

Check dedupe integrity:

```bash
docker compose exec postgres psql -U omen -d omen -c "select tx_hash, token_id, count(*) from fills group by 1,2 having count(*) > 1 limit 10;"
```

That last query should return zero rows.

## Validation Commands

```bash
pnpm run typecheck
pnpm run test
pnpm exec tsx src/cli.ts health
pnpm exec tsx src/cli.ts start
pnpm exec tsx src/cli.ts start --tui
pnpm exec tsx src/cli.ts replay
pnpm exec tsx src/cli.ts validate-fills analyze --input .phase0-data/overnight-24h
```
