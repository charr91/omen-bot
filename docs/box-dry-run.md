# Headless dry run on a Linux box

`scripts/box-run.sh start|stop|status` runs `omen start` headless (no TUI) with
`OMEN_OPERATIONAL_DRY_RUN=true` forced, so no Telegram/Discord alerts are sent.
Logs go to `logs/omen-<timestamp>.log` (gitignored), with `logs/omen.log` pointing
at the latest run.

`.env` (gitignored) for a box run:

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

## Box restart / auto-start (`scripts/box-boot.sh`)

The box keeps `/workspace` and `$HOME` across a restart but not system packages: after the 2026-10-12 20:40 PT
restart, apt Postgres 17 + Redis (and their data under `/var/lib/postgresql`, `/var/lib/redis`), cron, nvm/node 22
and `node_modules` were all gone. Everything omen had stored in Postgres before then (fills, alerts, outcomes) was lost.

### Durable data (since 2026-10-12 23:20 PT)

Postgres and Redis now run as the `box` user with their data under `/workspace`, which survives restarts:

| | binary | data | listen |
|---|---|---|---|
| Postgres 17 | apt `/usr/lib/postgresql/17/bin` | `/workspace/data/pg` (config in the data dir, log `/workspace/data/pg.log`) | `127.0.0.1:5433`, socket dir `/workspace/data/pg` |
| Redis | apt `redis-server` | `/workspace/data/redis` (RDB + AOF), config `/workspace/data/redis.conf` | `127.0.0.1:6379` |

Roles: `postgres` (superuser, local socket trust), `feed` (superuser, `feed_local_box`), `omen` (`omen`).
DBs: `omen` (owner `omen`), `smart_money_feed` (owner `feed`). Both `.env` files point at port 5433.
`scripts/box-db.sh` reinstalls the apt binaries if they are missing, keeps the apt cluster (`/var/lib/postgresql`,
start.conf `manual`) and the apt redis service stopped, and starts both servers. `box-boot.sh` and `box-run.sh` call it.

The Docker container `smart-money-feed-pg` on `127.0.0.1:5432` (postgres:16-alpine) is no longer used. The box has
no docker CLI or socket, so its volume can't be inspected, and its data was lost in the 20:40 PT restart. Treat it as
non-persistent. Its data was moved over with `pg_dump`/`pg_restore` (row counts checked per table).
Don't point anything back at 5432.

`scripts/box-boot.sh` is idempotent. It:
1. reinstalls nvm + node 22.23.3 and runs `npm ci` if they are missing, and reinstalls cron;
2. runs `scripts/box-db.sh` (Postgres 5433 + Redis from `/workspace/data`). It stops if `/workspace/data/pg` is missing;
3. creates the `omen`/`feed` roles and DBs if they are missing;
4. installs the crontab: `@reboot` (`>> logs/box-boot.log`) and `scripts/backup.sh` every 6 h at :17 (`>> logs/backup.log`);
5. runs `scripts/box-run.sh start` (omen dry run);
6. runs `smart-money-feed migrate` and starts `smart-money-feed run` (pid `../smart-money-feed/logs/feed.pid`,
   log `../smart-money-feed/logs/feed.log`), using omen's `.env` and then the feed's gitignored `.env`.

### Backups (`scripts/backup.sh`)

- `pg_dump -Fc` of `omen` and `smart_money_feed`, plus `pg_dumpall --roles-only`, into `/workspace/backups/<YYYYmmdd-HHMMSS>/`.
- The run is also tarred and gpg-encrypted (symmetric AES256) to `/workspace/backups/box-db-<ts>.tar.gpg`.
  The passphrase is in `/workspace/data/backup.key` (mode 600, never committed). **Keep a copy of that key off the box
  as well (e.g. a password manager).** Without it the off-box copies can't be decrypted.
- Local rotation keeps the newest 28 dump dirs and 28 archives (`KEEP_LOCAL`).
- Off-box: the archive is uploaded as an asset on the `db` release of the **private** GitHub repo
  `charr91/omen-box-backups` (via `gh`, created on first run). The newest 14 are kept (`KEEP_REMOTE`).
  A run is about 1.7 MB. Set `BACKUP_OFFBOX=0` for a local-only run.

Restore (tested 2026-10-12 into scratch DBs `restore_test_*` from the downloaded release asset: exact row counts on all
18 omen and 7 feed tables):

```bash
gh release download db -R charr91/omen-box-backups -p 'box-db-<ts>.tar.gpg'
gpg --batch --pinentry-mode loopback --passphrase-file /workspace/data/backup.key -d box-db-<ts>.tar.gpg | tar -xf -
P="-h /workspace/data/pg -p 5433 -U postgres"
psql $P -c 'create database restore_test'; pg_restore $P -d restore_test --no-owner <ts>/omen.dump
# full rebuild of a lost cluster: initdb -D /workspace/data/pg -U postgres (port/listen/socket lines as in box-db.sh header),
# start it, psql -f <ts>/roles.sql, create the DBs with their owners, pg_restore each dump.
```

Since cron itself is wiped by a box restart, the `@reboot` line may not survive one. After a restart, run
`scripts/box-boot.sh` once by hand (or from an agent). It brings everything back and reinstalls the hook.

### Feed delivery (Telegram test channel)

omen publishes every promoted alert to the feed even with `OMEN_OPERATIONAL_DRY_RUN=true`, and with
`[feed] disable_legacy_channels = true` it never sends on its own Telegram/Discord. The feed process alone owns
delivery. Its `.env` holds `FEED_TELEGRAM_BOT_TOKEN`, `FEED_TELEGRAM_CHAT_ID`, `FEED_MIN_SEVERITY=medium` (LOW/INFO are
marked `dry_run`, never sent) and `FEED_MESSAGE_PREFIX="🧪 TEST"`. Sending is live only with `FEED_DRY_RUN=false`
there, then restart the feed (kill the pid in `feed.pid`, remove the file, run `scripts/box-boot.sh`).
