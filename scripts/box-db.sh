#!/usr/bin/env bash
# Start the box's durable Postgres + Redis. Both run as the box user with data under /workspace/data (survives restarts).
#   Postgres 17 (apt binaries), data /workspace/data/pg, 127.0.0.1:5433, socket dir /workspace/data/pg, superuser postgres (local trust)
#   Redis (apt binary), config /workspace/data/redis.conf, data /workspace/data/redis (RDB + AOF), 127.0.0.1:6379
# The apt-managed cluster (/var/lib/postgresql, wiped by restarts) and the apt redis service are kept stopped.
# 5432 is the Docker container smart-money-feed-pg; its volume is not on persistent storage, so nothing uses it any more.
set -uo pipefail
DATA="${BOX_DATA_DIR:-/workspace/data}"; PGDATA="$DATA/pg"; PGPORT=5433
apt_in() { sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null; }
PGBIN="$(ls -d /usr/lib/postgresql/17/bin 2>/dev/null)"
[ -n "$PGBIN" ] && command -v redis-server >/dev/null || { sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq; apt_in postgresql-17 postgresql-client-17 redis-server gnupg; PGBIN=/usr/lib/postgresql/17/bin; }
# keep the apt cluster/service down so they never grab 5433/6379 or get used by accident
for c in /etc/postgresql/*/main/start.conf; do [ -f "$c" ] && echo manual | sudo -n tee "$c" >/dev/null; done
sudo -n service postgresql stop >/dev/null 2>&1 || true
sudo -n service redis-server stop >/dev/null 2>&1 || true
[ -f "$PGDATA/PG_VERSION" ] || { echo "missing $PGDATA: restore from /workspace/backups (see docs/box-dry-run.md)" >&2; exit 1; }
"$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1 || "$PGBIN/pg_ctl" -D "$PGDATA" -l "$DATA/pg.log" -w start >/dev/null
redis-cli -p 6379 ping >/dev/null 2>&1 || redis-server "$DATA/redis.conf"
for _ in $(seq 30); do pg_isready -q -h 127.0.0.1 -p $PGPORT && redis-cli ping >/dev/null 2>&1 && exit 0; sleep 1; done
echo "postgres/redis did not come up" >&2; exit 1
