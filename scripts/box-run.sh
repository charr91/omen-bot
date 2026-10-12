#!/usr/bin/env bash
# Headless dry-run start/stop helper for a Linux box (no TUI, no screen). See docs/box-dry-run.md.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_BIN="${OMEN_NODE_BIN:-$HOME/.nvm/versions/node/v22.23.3/bin}"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
# This helper is for dry runs only: never dispatch alerts from it.
export OMEN_OPERATIONAL_DRY_RUN=true
mkdir -p logs
PIDFILE=logs/omen.pid
case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "already running pid $(cat $PIDFILE)"; exit 0; fi
    sudo -n service postgresql start >/dev/null 2>&1 || true
    sudo -n service redis-server start >/dev/null 2>&1 || true
    LOG="logs/omen-$(date +%Y%m%d-%H%M%S).log"
    nohup setsid node node_modules/tsx/dist/cli.mjs src/cli.ts start >"$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"; ln -sf "$(basename "$LOG")" logs/omen.log
    echo "started pid $(cat $PIDFILE), log $LOG" ;;
  stop)
    [ -f "$PIDFILE" ] || { echo "no pidfile"; exit 0; }
    PID="$(cat $PIDFILE)"
    # Signal only the CLI; it stops the hot worker and cold-worker child itself. SIGKILL the group as a fallback.
    kill -TERM "$PID" 2>/dev/null || true
    echo "sent SIGTERM to $PID; waiting up to 90s"
    for _ in $(seq 90); do pgrep -g "$PID" >/dev/null || break; sleep 1; done
    if pgrep -g "$PID" >/dev/null; then echo "still alive; SIGKILL"; kill -KILL -- "-$PID" 2>/dev/null || true; fi
    rm -f "$PIDFILE"; echo stopped ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "running pid $(cat $PIDFILE)"; else echo "not running"; fi ;;
esac
