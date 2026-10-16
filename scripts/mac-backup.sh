#!/usr/bin/env bash
# Mac server backups (launchd com.smartmoney.backup, every 6h): reuse scripts/backup.sh against Homebrew PG17 on 5433,
# same gpg key, off-machine upload to charr91/omen-box-backups release "db" (assets box-db-*). See docs/server-mac.md.
set -euo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SM="$HOME/smart-money"
export BACKUP_PREFIX=mac-db BACKUP_DIR="$SM/backups/auto" BACKUP_KEY="$SM/data/backup.key" PGHOST=localhost PGPORT=5433 PGUSER="${PGUSER:-$USER}"
mkdir -p "$BACKUP_DIR"
exec "$(dirname "$0")/backup.sh"
