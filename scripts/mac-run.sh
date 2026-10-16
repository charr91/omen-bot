#!/usr/bin/env bash
# launchd entrypoint on the Mac server (see docs/server-mac.md). Runs in the foreground; launchd KeepAlive restarts it.
#   scripts/mac-run.sh omen   -> omen (always OMEN_OPERATIONAL_DRY_RUN=true from here)
#   scripts/mac-run.sh feed   -> smart-money-feed `run` (delivery governed by the feed's own .env)
#   scripts/mac-run.sh feed-cli <args>  -> one-off feed CLI with the same env (used by the X bridge)
set -euo pipefail
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
OMEN_DIR="$(cd "$(dirname "$0")/.." && pwd)"; FEED_DIR="${FEED_DIR:-$OMEN_DIR/../smart-money-feed}"
for _ in $(seq 60); do pg_isready -q -h localhost -p 5433 && break; sleep 2; done
case "${1:-}" in
  omen)
    cd "$OMEN_DIR"; export OMEN_OPERATIONAL_DRY_RUN=true
    exec node node_modules/tsx/dist/cli.mjs src/cli.ts start ;;
  feed|feed-cli)
    set -a; . "$OMEN_DIR/.env"; [ -f "$FEED_DIR/.env" ] && . "$FEED_DIR/.env"; set +a
    cd "$FEED_DIR"
    if [ "$1" = feed ]; then node dist/cli.js migrate; exec node dist/cli.js run; fi
    shift; exec node dist/cli.js "$@" ;;
  *) echo "usage: $0 omen|feed|feed-cli <args>" >&2; exit 2 ;;
esac
