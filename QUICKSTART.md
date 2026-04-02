# Quick Start

This is the fastest path from clone to a running Omen detector instance.

## Requirements

- Node.js 22+
- `pnpm`
- Docker / Docker Compose
- An `ALCHEMY_API_KEY`
- Optional Telegram bot and Discord webhook credentials if you want external alerts

## 1. Install And Configure

```bash
pnpm install
cp .env.example .env
```

Edit `.env` and set:

```bash
ALCHEMY_API_KEY=your-alchemy-key
```

Optional external alert config:

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID_CRITICAL=
TELEGRAM_CHAT_ID_MEDIUM=
DISCORD_WEBHOOK_CRITICAL=
DISCORD_WEBHOOK_MEDIUM=
```

Blank optional values are treated as unset, so the default `.env.example` is safe to copy as-is.

## 2. Start Local Services

```bash
docker compose up -d
pnpm exec tsx src/cli.ts health
```

Expected local endpoints:
- Postgres: `localhost:15432`
- Redis: `localhost:16379`

Expected health behavior:
- Before `start` or `replay` is running, `hotWorker` may be degraded because there is no active heartbeat yet
- While `start` or `replay` is running, overall health should be `ok`

## 3. Run The Bot

Headless logs:

```bash
pnpm exec tsx src/cli.ts start
```

Interactive TUI:

```bash
pnpm exec tsx src/cli.ts start --tui
```

Managed screen session:

```bash
pnpm run omen:screen:start
pnpm run omen:screen:attach
```

Use headless mode when you want raw JSON logs.

Use the TUI when you want:
- a promoted-alert feed
- queue and worker state
- a live dry-run toggle

TUI controls:
- `q`: quit
- `?`: help
- `t`: cycle alert-tier filter
- `d`: toggle external-alert dry-run
- `Esc`: reset help/filter

## 4. Understand The Output

Headless mode emits:
- `ingest-cycle`
- `signal-preview`
- `alert-dispatch`
- `runtime-stats`

Important distinction:
- `signal-preview` is every persisted LIVE signal event
- operator alerts are only promoted LOW+ outcomes
- the TUI prefers promoted alerts and otherwise falls back to recent signal previews

## 5. Recovery And Verification

Drain persisted backlog:

```bash
pnpm exec tsx src/cli.ts replay
```

If replay returns:

```json
{"type":"replay","replayed":0}
```

there was no pending hot-path backlog.

Check for stuck fills:

```bash
docker compose exec postgres psql -U omen -d omen -c "select count(*) filter (where analyzed = false) as unanalyzed from fills;"
```

Inspect recent signal events:

```bash
docker compose exec postgres psql -U omen -d omen -c "select signal_id, wallet_address, market_id, score, confidence, created_at from signal_events order by created_at desc limit 20;"
```

Optional admin commands:

```bash
pnpm exec tsx src/cli.ts whitelist list
pnpm exec tsx src/cli.ts proxy-override list
pnpm exec tsx src/cli.ts quarantine list --limit 20
```

## 6. Current Practical Expectations

- The first run may backfill hundreds of fills
- `OUTSIZED_POSITION` should fire on live traffic now
- `FRESH_WALLET_LARGE_POSITION` uses controller attribution for contract wallets when it can be resolved; otherwise it suppresses conservatively
- The TUI may show recent previews before any LOW+ alert promotes
- Dust fills are filtered out of `SYBIL_CLUSTER` alert promotion
- Telegram and Discord alerts only send when a promoted alert reaches LOW+ and the channel is configured

For screenshots and the longer operational reference, see [README.md](README.md).
