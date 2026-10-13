#!/usr/bin/env bash
# Idempotent box bring-up after a restart: Postgres (5433, /workspace/data/pg) + Redis (/workspace/data/redis), omen dry run, smart-money-feed dry run.
# Reinstalls apt binaries if the box came back without them; data lives under /workspace and is not recreated. See docs/box-dry-run.md.
set -uo pipefail
cd "$(dirname "$0")/.."
OMEN_DIR="$PWD"; FEED_DIR="${FEED_DIR:-$OMEN_DIR/../smart-money-feed}"
NODE_VER=22.23.3; NODE_BIN="${OMEN_NODE_BIN:-$HOME/.nvm/versions/node/v$NODE_VER/bin}"
if [ ! -x "$NODE_BIN/node" ]; then  # omen needs node >=22; the box's /usr/bin/node is 20
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
  . "$NVM_DIR/nvm.sh"; nvm install "$NODE_VER" >/dev/null
fi
export PATH="$NODE_BIN:$PATH"
[ -d node_modules ] || npm ci --no-audit --no-fund
# Postgres (5433) + Redis (6379): user-run, data under /workspace/data, started by scripts/box-db.sh.
command -v cron >/dev/null || sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron >/dev/null
sudo -n service cron start >/dev/null 2>&1 || true
scripts/box-db.sh || exit 1
psql_admin() { psql -h /workspace/data/pg -p 5433 -U postgres -qtAc "$1"; }
[ "$(psql_admin "select 1 from pg_roles where rolname='feed'")" = 1 ] || psql_admin "create role feed login superuser password 'feed_local_box'"
[ "$(psql_admin "select 1 from pg_database where datname='smart_money_feed'")" = 1 ] || psql_admin "create database smart_money_feed owner feed"
# (re)install the @reboot hook
( crontab -l 2>/dev/null | grep -v -e box-boot.sh -e backup.sh; echo "@reboot $OMEN_DIR/scripts/box-boot.sh >>$OMEN_DIR/logs/box-boot.log 2>&1"
  echo "17 */6 * * * $OMEN_DIR/scripts/backup.sh >>$OMEN_DIR/logs/backup.log 2>&1" ) | crontab -
mkdir -p logs
scripts/box-run.sh start
# feed: same Postgres (5433), DB smart_money_feed, always dry run from here
# omen .env gives FEED_DATABASE_URL; the feed's own gitignored .env (Telegram token/chat, FEED_DRY_RUN,
# FEED_MIN_SEVERITY, FEED_MESSAGE_PREFIX) is loaded after it. Delivery stays dry unless that file says FEED_DRY_RUN=false.
set -a; . "$OMEN_DIR/.env"; [ -f "$FEED_DIR/.env" ] && . "$FEED_DIR/.env"; set +a
cd "$FEED_DIR"; mkdir -p logs
if [ -f logs/feed.pid ] && kill -0 "$(cat logs/feed.pid)" 2>/dev/null; then echo "feed already running pid $(cat logs/feed.pid)"; else
  node dist/cli.js migrate
  LOG="logs/feed-$(date +%Y%m%d-%H%M%S).log"
  nohup setsid node dist/cli.js run >"$LOG" 2>&1 </dev/null & echo $! > logs/feed.pid; ln -sf "$(basename "$LOG")" logs/feed.log
  echo "feed started pid $(cat logs/feed.pid), log $FEED_DIR/$LOG"
fi
