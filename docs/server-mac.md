# Server Mac (Bottys-MacBook-Pro-3) — production home of the smart-money stack

Migrated off the shared Linux box on 2026-10-16. The box copy is **stopped** (data kept, nothing deleted).

## What runs where

| Thing | Mac (live) | Box (stopped) |
|---|---|---|
| omen (dry run, legacy channels off) | launchd `com.smartmoney.omen` → `scripts/mac-run.sh omen` | `/workspace/omen-bot`, stopped |
| smart-money-feed `run` (FEED_DRY_RUN=false, min severity medium, prefix `🧪 TEST`) | launchd `com.smartmoney.feed` → `scripts/mac-run.sh feed` | `/workspace/smart-money-feed`, stopped |
| Postgres 17 (DBs `omen`, `smart_money_feed`) | Homebrew `postgresql@17`, port **5433**, launchd `homebrew.mxcl.postgresql@17`, data `/opt/homebrew/var/postgresql@17` | `/workspace/data/pg` (kept) |
| Redis | own instance on port **6380** (AOF), launchd `com.smartmoney.redis`, conf `~/smart-money/data/redis.conf`, data `~/smart-money/data/redis` | `/workspace/data/redis` (kept) |
| Backups | launchd `com.smartmoney.backup` every 6h → `scripts/mac-backup.sh` | box cron entries commented out (`# migrated-to-mac`) |

The Mac already runs other projects on Homebrew `postgresql@18` (5432) and `redis` (6379); these are **not** used by
the smart-money stack and must not be touched. Hence PG17 on 5433 and a separate Redis on 6380.

Layout: `~/smart-money/{omen-bot,smart-money-feed,data,logs,backups}` (user `bot`). Node 22 from `node@22`
(`/opt/homebrew/opt/node@22/bin`; the default `node` on this Mac is 25 and is not used). Plists live in
`~/Library/LaunchAgents/com.smartmoney.*.plist`; `KeepAlive` restarts omen/feed/redis, `RunAtLoad` starts them at login.

- Logs: `~/smart-money/logs/{omen,feed,redis,backup}.log`
- Env: `omen-bot/.env` (REDIS_URL → 6380, Postgres 5433) and `smart-money-feed/.env` (Telegram token/chat), both chmod 600, not committed.
- Config: `omen.config.toml` `[alchemy] hot_budget_share = 0.4` (owner-approved 2026-10-16: hot 40%, cold path 60%).

Control:
```
launchctl kickstart -k gui/$(id -u)/com.smartmoney.omen     # restart omen
launchctl kickstart -k gui/$(id -u)/com.smartmoney.feed     # restart feed
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.smartmoney.omen.plist   # stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.smartmoney.omen.plist # start
```

## X bridge (Grok Bot)

The bridge still runs on the box but executes the feed CLI on the Mac (Shell with the Mac's machineId):
```
~/smart-money/omen-bot/scripts/mac-run.sh feed-cli x pending --json
~/smart-money/omen-bot/scripts/mac-run.sh feed-cli x submit -      # JSON on stdin (or a file path on the Mac)
~/smart-money/omen-bot/scripts/mac-run.sh feed-cli x status
```
`mac-run.sh feed-cli` loads the same env as the running feed and uses node 22.

## Backups

`scripts/mac-backup.sh` wraps `scripts/backup.sh` (now BSD/GNU portable): pg_dump of `omen` + `smart_money_feed` + roles,
tar, gpg AES256 with `~/smart-money/data/backup.key` (same key as the box, chmod 600; **keep a second copy offline**),
local rotation in `~/smart-money/backups/auto` (28), upload to `charr91/omen-box-backups` release `db` as
`mac-db-<ts>.tar.gpg` (newest 14 kept; box archives keep their `box-db-` prefix and are not rotated by the Mac).

Restore:
```
gh release download db -R charr91/omen-box-backups -p mac-db-<ts>.tar.gpg
gpg --batch --pinentry-mode loopback --passphrase-file ~/smart-money/data/backup.key -d mac-db-<ts>.tar.gpg | tar -xf -
createdb -h localhost -p 5433 restore_test && pg_restore --no-owner -d restore_test <ts>/omen.dump
```

## Migration record (2026-10-16)

1. Box omen (pid 52604) and feed (pid 52646) stopped ~03:40 PT; box `@reboot`/backup cron commented out (saved copy: box `logs/crontab.pre-mac-migration`).
2. Fresh pg_dump + Redis RDB at 03:40:49 PT, shipped as gpg-encrypted `box-migration-20261016-034049.tgz.gpg` via the `db` release (direct copy was too large), restored into PG17/Redis on the Mac.
3. Row counts matched for every table in both DBs (e.g. fills 510396, kalshi_trades 535495, alerts 4098, wallets 29018, ingest_quarantine 1399265, feed.alerts 36230, feed.outcomes 35692, feed.x_results 3308).
4. omen and feed started under launchd at **2026-10-16 03:51:10 PT**; ingest, cold worker, outcome tracker and feed sync resumed. One `🧪 TEST migration ok` Telegram message sent (ok).
5. First Mac backup `mac-db-20261016-035227.tar.gpg` uploaded; downloaded, decrypted and restored into a scratch DB successfully (dropped afterwards).

**M0 is signed off.** A **24h continuity recheck** started when omen went live on the Mac: 2026-10-16 03:51:10 PT → due 2026-10-17 03:51 PT.

## Needs the owner (sudo)

The Mac currently reports `SleepDisabled 1` / `sleep 0` but that is held by another app's assertion. To make it permanent:
`sudo pmset -a sleep 0 disksleep 0 standby 0 autorestart 1` (and enable auto-login for `bot` so LaunchAgents start after a power cut).
