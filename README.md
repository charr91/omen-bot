# Omen Bot

Thin-slice Phase 1 Polymarket ingest bot.

Current state:
- Persists live Polymarket fills into Postgres
- Dedupes fills on `(tx_hash, token_id)`
- Replays `analyzed = false` fills
- Exposes `start`, `replay`, and `health` commands

Not built yet:
- TUI
- Telegram alerts
- Wallet profiling
- Hot-path scoring beyond a no-op analyzer

## Quick Start

Requirements:
- Node.js 22+
- `pnpm`
- Docker / Docker Compose

Install and boot local dependencies:

```bash
pnpm install
cp .env.example .env
docker compose up -d
npm run build
pnpm exec tsx src/cli.ts health
```

If `health` returns overall `"status": "ok"`, start the ingest loop:

```bash
pnpm exec tsx src/cli.ts start
```

The bot will print one JSON line per ingest cycle, for example:

```json
{"type":"ingest-cycle","checkpoint":"2026-03-30T08:15:00.000Z","fetched":120,"inserted":42,"replayed":0}
```

Key fields:
- `fetched`: trades pulled from Polymarket in that cycle
- `inserted`: new fills written to Postgres
- `replayed`: previously pending fills marked analyzed

## Initial SQL Inspection

Check whether the bot is writing fills:

```bash
docker compose exec postgres psql -U omen -d omen -c "select count(*) as fills, max(timestamp) as newest_fill from fills;"
```

Inspect the newest rows:

```bash
docker compose exec postgres psql -U omen -d omen -c "select tx_hash, token_id, wallet_address, side, outcome, price, shares, timestamp, analyzed from fills order by timestamp desc limit 10;"
```

Check that dedupe is holding:

```bash
docker compose exec postgres psql -U omen -d omen -c "select tx_hash, token_id, count(*) from fills group by 1,2 having count(*) > 1 limit 10;"
```

That last query should return zero rows.

## Live Local Smoke Test

Terminal 1:

```bash
docker compose up -d
pnpm exec tsx src/cli.ts health
pnpm exec tsx src/cli.ts start
```

Wait until you see at least one `ingest-cycle` line with `inserted > 0`.

Terminal 2:

```bash
docker compose exec postgres psql -U omen -d omen -c "select count(*) as fills, max(timestamp) as newest_fill from fills;"
docker compose exec postgres psql -U omen -d omen -c "select tx_hash, token_id, wallet_address, side, outcome, price, shares, timestamp from fills order by timestamp desc limit 10;"
```

Terminal 3, optional replay check:

```bash
pnpm exec tsx src/cli.ts replay
```

Success looks like:
- `health` reports `postgres`, `redis`, and `polymarketRest` as `ok`
- `start` emits ingest-cycle JSON continuously
- the `fills` row count increases
- newest fill timestamps advance over time
- replay does not create duplicates

## Useful Commands

```bash
pnpm exec tsx src/cli.ts health
pnpm exec tsx src/cli.ts start
pnpm exec tsx src/cli.ts replay
pnpm exec tsx src/cli.ts validate-fills analyze --input .phase0-data/overnight-24h
```
