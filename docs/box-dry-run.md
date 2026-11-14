# Headless dry run on a Linux host

`scripts/box-run.sh start|stop|status` runs `omen start` headless (no TUI) with
`OMEN_OPERATIONAL_DRY_RUN=true` forced, so no Telegram/Discord alerts are sent.
Logs go to `logs/omen-<timestamp>.log` (gitignored), with `logs/omen.log` pointing
at the latest run.

`.env` (gitignored) example for a host run:

```
DATABASE_URL=postgresql://omen:omen@localhost:5433/omen
REDIS_URL=redis://localhost:6379
ALCHEMY_API_KEY=...            # optional, see below
OMEN_OPERATIONAL_DRY_RUN=true
LOG_PRETTY=false
# leave all TELEGRAM_* / DISCORD_* blank
```

`OMEN_ALLOW_MISSING_ALCHEMY=true` lets `start` run without `ALCHEMY_API_KEY`.
Every wallet profile then uses the conservative fallback and funding-graph jobs
fail with a cooldown, so wallet-based signals cannot fire.

`stop` sends SIGTERM to the CLI, which stops ingestion, finishes the in-flight
fill (queued fills stay unanalyzed and are replayed on next start), stops the
cold-worker child and exits. If anything is still alive after 90s, the process
group is SIGKILLed.

## Alchemy budget knobs (`[alchemy]` in omen.config.toml)

| key | default | env override | purpose |
|---|---|---|---|
| hot_cu_per_second | 120 (code default 200) | OMEN_ALCHEMY_HOT_CU_PER_SECOND | hot-worker token bucket |
| cold_cu_per_second | 160 (code default 80) | OMEN_ALCHEMY_COLD_CU_PER_SECOND | funding-graph token bucket |
| max_wait_ms | 20000 | OMEN_ALCHEMY_MAX_WAIT_MS | max wait for capacity before a request is rejected |
| max_queue | 500 | n/a | max waiters per bucket |
| max_429_retries | 3 | n/a | retries on HTTP 429 (honours Retry-After) |
| min_profile_fill_usd | 500 (box: 1000) | OMEN_ALCHEMY_MIN_PROFILE_FILL_USD | Alchemy profiling only at/above this (capped at large_position_min_usd so fresh-wallet always gets a profile). Fills from the lowest signal min ($200) up to this are evaluated with the persisted/conservative profile (no CU); below $200 they are skipped |
| profile_cache_ttl_ms | 86400000 | OMEN_ALCHEMY_PROFILE_CACHE_TTL_MS | in-memory wallet and controller profile cache TTL (24h) |
| persisted_profile_ttl_ms | 604800000 | - | Postgres-persisted effective profiles of settled wallets (never fresh again), reused across restarts for 7d; per-day mode counts in Redis `omen:hot:profile-modes:<day>` |
| daily_cu_budget | 1000000 | OMEN_ALCHEMY_DAILY_CU_BUDGET | CU per UTC day (about 30M/month); 0 = unlimited |
| hot_budget_share | 0.4 | n/a | hot worker's share; the cold path gets the rest |

Hot + cold = 280 CU/s, under the 330 CU/s free-tier limit.

## Proxy controller attribution

Polymarket proxy wallets are funded with USDC/USDC.e/pUSD, not POL. The
controller (owner EOA) is read on-chain: `owner()` for beacon-proxy deposit
wallets, Gnosis Safe owner storage for Safes, `isOwner()` checks against the
first inbound funders, and finally a single unique inbound sender. The wallet's
age is then the controller's age.

## Cold path

Funding-graph rebuilds are requested only for fills >= `[cold_path] rebuild_min_fill_usd`
(500) or wallets that already triggered a signal (`rebuild_if_signaled`). Each graph uses
at most `detection.cluster.max_rpc_calls` (31) `getAssetTransfers` calls, and block
timestamps come from transfer metadata (no per-edge block lookups).

Funding-graph jobs are deduped per wallet. When a job runs, it completes without any
Alchemy calls if the wallet's graph is younger than 24h, or the wallet has neither a fill
>= `rebuild_min_fill_usd` in the last 24h nor a signal (`status: "skipped"` in the log).
`[cold_path] concurrency = 2`.

## Alchemy CU usage

Every metered Alchemy call adds its CU weight to the Redis hash
`omen:alchemy:cu:<YYYY-MM-DD UTC>` (fields `hot`, `cold`; kept 40 days). Each
`runtime-stats` log line carries `alchemyCu` (today's total, per component, and a
30-day projection), and an `alchemy-cu-daily` line is logged after each UTC day ends.
Once a component reaches its share, the hot worker serves cached profiles and gives
uncached wallets the conservative profile (fresh-wallet signals can't fire), and the cold
path skips rebuilds (`reason: "daily-budget"`) until 00:00 UTC.
Check it by hand with `redis-cli hgetall omen:alchemy:cu:$(date -u +%F)`.

## Auto-start (`scripts/box-boot.sh`)

`scripts/box-boot.sh` is an idempotent helper for a Linux host that keeps project data on a persistent volume
(the scripts default to a `data/` directory next to the repo when you point them there). It:

1. reinstalls Node if needed and runs the package install;
2. starts local Postgres and Redis via `scripts/box-db.sh` when that helper is configured;
3. creates the `omen` / feed roles and databases if they are missing;
4. can install a crontab for `@reboot` and periodic `scripts/backup.sh` (that backup script requires env vars; see below);
5. runs `scripts/box-run.sh start` (omen dry run);
6. if a sibling feed checkout exists, runs its migrate/start using omen's `.env` and then the feed's gitignored `.env`.

### Backups (`scripts/backup.sh`)

`scripts/backup.sh` dumps the configured databases, encrypts the archive with a local gpg passphrase file, and
can upload it to a GitHub release with `gh`. It **requires** `BACKUP_REPO`, `BACKUP_DIR`, `BACKUP_KEY`,
`PGHOST`, `PGPORT`, and `PGUSER`. It exits with a usage error if any of those are unset. Optional knobs:
`BACKUP_PREFIX`, `BACKUP_TAG`, `KEEP_LOCAL`, `KEEP_REMOTE`, `BACKUP_OFFBOX=0` (local only), `BACKUP_DATABASES`.

Keep a second copy of the passphrase file offline. Without it, off-host copies cannot be decrypted. A restore looks like:

```bash
gh release download "$BACKUP_TAG" -R "$BACKUP_REPO" -p "$BACKUP_PREFIX-<ts>.tar.gpg"
gpg --batch --pinentry-mode loopback --passphrase-file "$BACKUP_KEY" -d "$BACKUP_PREFIX-<ts>.tar.gpg" | tar -xf -
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -c 'create database restore_test'
pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d restore_test --no-owner <ts>/omen.dump
```

See [operations.md](operations.md) for the full env list.

### Feed delivery (Telegram test channel)

omen publishes every promoted alert to the feed even with `OMEN_OPERATIONAL_DRY_RUN=true`, and with
`[feed] disable_legacy_channels = true` it never sends on its own Telegram/Discord. The feed process alone owns
delivery. Its `.env` holds `FEED_TELEGRAM_BOT_TOKEN`, `FEED_TELEGRAM_CHAT_ID`, `FEED_MIN_SEVERITY=medium` (LOW/INFO are
marked `dry_run`, never sent) and `FEED_MESSAGE_PREFIX="🧪 TEST"`. Sending is live only with `FEED_DRY_RUN=false`
there, then restart the feed (kill the pid in `feed.pid`, remove the file, run `scripts/box-boot.sh`).
