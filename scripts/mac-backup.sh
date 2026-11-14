#!/usr/bin/env bash
# Thin wrapper around scripts/backup.sh for a launchd/cron host.
# Host paths, ports, and the destination repo must come from the environment (no hardcoded machine, user, or repo).
set -euo pipefail

if [ -n "${BACKUP_PATH_PREFIX:-}" ]; then
  export PATH="$BACKUP_PATH_PREFIX:$PATH"
fi

exec "$(dirname "$0")/backup.sh"
