#!/usr/bin/env bash

set -euo pipefail

export PATH="/opt/homebrew/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCREEN_SCRIPT="$REPO_ROOT/scripts/omen-screen.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/omen-launchd.sh ensure
EOF
}

ensure_session() {
  if /bin/bash "$SCREEN_SCRIPT" is-running >/dev/null 2>&1; then
    printf 'omen screen session already running\n'
    exit 0
  fi

  exec /bin/bash "$SCREEN_SCRIPT" start
}

main() {
  case "${1:-}" in
    ensure)
      ensure_session
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
