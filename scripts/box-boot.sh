#!/usr/bin/env bash
# Idempotent box bring-up after a restart: Postgres (5432) + Redis, omen dry run, smart-money-feed dry run.
# Reinstalls the apt packages and recreates roles/DBs if the box came back without them. See docs/box-dry-run.md.
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
# Postgres on 5432: since the 2026-10-12 restart this is the Docker container smart-money-feed-pg (postgres:16-alpine,
# 127.0.0.1:5432, superuser feed), managed outside the box's view (no docker CLI/socket here). omen and the feed both use it.
# Only if nothing answers on 5432 do we fall back to native apt Postgres 17, moved to port 5432.
command -v redis-server >/dev/null && command -v cron >/dev/null && command -v pg_isready >/dev/null || {
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-client redis-server cron >/dev/null; }
sudo -n service redis-server start >/dev/null; sudo -n service cron start >/dev/null 2>&1 || true
if pg_isready -q -h 127.0.0.1 -p 5432; then
  psql_admin() { PGPASSWORD=feed_local_box psql -h 127.0.0.1 -U feed -d postgres -qtAc "$1"; }
else
  [ -d /usr/lib/postgresql ] || sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null
  sudo -n sed -i 's/^port = .*/port = 5432/' /etc/postgresql/*/main/postgresql.conf
  sudo -n service postgresql start >/dev/null
  for _ in $(seq 30); do pg_isready -q -h 127.0.0.1 && break; sleep 1; done
  psql_admin() { sudo -n -u postgres psql -qtAc "$1"; }
  [ "$(psql_admin "select 1 from pg_roles where rolname='feed'")" = 1 ] || psql_admin "create role feed login password 'feed_local_box'"
  [ "$(psql_admin "select 1 from pg_database where datname='smart_money_feed'")" = 1 ] || psql_admin "create database smart_money_feed owner feed"
fi
[ "$(psql_admin "select 1 from pg_roles where rolname='omen'")" = 1 ] || psql_admin "create role omen login password 'omen'"
[ "$(psql_admin "select 1 from pg_database where datname='omen'")" = 1 ] || psql_admin "create database omen owner omen"
# (re)install the @reboot hook
( crontab -l 2>/dev/null | grep -v box-boot.sh; echo "@reboot $OMEN_DIR/scripts/box-boot.sh >>$OMEN_DIR/logs/box-boot.log 2>&1" ) | crontab -
mkdir -p logs
scripts/box-run.sh start
# feed: same Postgres (5432), DB smart_money_feed, always dry run from here
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
