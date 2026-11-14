#!/usr/bin/env bash

set -euo pipefail

export PATH="/opt/homebrew/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.larry.omen"
PLIST_SOURCE="$REPO_ROOT/launchd/$LABEL.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SCREEN_SCRIPT="$REPO_ROOT/scripts/omen-screen.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/omen-launchdctl.sh install
  scripts/omen-launchdctl.sh uninstall
  scripts/omen-launchdctl.sh status [--verbose]
EOF
}

install_agent() {
  mkdir -p "$(dirname "$PLIST_TARGET")"
  sed "s|__OMEN_REPO_ROOT__|$REPO_ROOT|g" "$PLIST_SOURCE" >"$PLIST_TARGET"
  chmod 644 "$PLIST_TARGET"
  /bin/launchctl bootout "$DOMAIN" "$PLIST_TARGET" >/dev/null 2>&1 || true
  /bin/launchctl bootstrap "$DOMAIN" "$PLIST_TARGET"
  /bin/launchctl kickstart -k "$DOMAIN/$LABEL"
  printf 'installed launch agent %s\n' "$LABEL"
}

uninstall_agent() {
  /bin/launchctl bootout "$DOMAIN" "$PLIST_TARGET" >/dev/null 2>&1 || true
  rm -f "$PLIST_TARGET"
  printf 'removed launch agent %s\n' "$LABEL"
}

print_summary_field() {
  local label="$1"
  local value="$2"
  printf '%-16s %s\n' "$label" "$value"
}

status_agent() {
  local verbose="${1:-}"

  if [[ ! -f "$PLIST_TARGET" ]]; then
    printf 'not installed: %s\n' "$PLIST_TARGET"
    exit 1
  fi

  local launchctl_output
  launchctl_output="$(/bin/launchctl print "$DOMAIN/$LABEL" 2>&1 || true)"

  if [[ "$verbose" == "--verbose" ]]; then
    printf 'installed: %s\n' "$PLIST_TARGET"
    printf '%s\n' "$launchctl_output"
    return
  fi

  local state last_exit_code working_directory stdout_path stderr_path pid run_interval
  local agent_mode
  state="$(sed -n 's/^[[:space:]]*state = //p' <<<"$launchctl_output" | head -n 1)"
  last_exit_code="$(sed -n 's/^[[:space:]]*last exit code = //p' <<<"$launchctl_output" | head -n 1)"
  working_directory="$(sed -n 's/^[[:space:]]*working directory = //p' <<<"$launchctl_output" | head -n 1)"
  stdout_path="$(sed -n 's/^[[:space:]]*stdout path = //p' <<<"$launchctl_output" | head -n 1)"
  stderr_path="$(sed -n 's/^[[:space:]]*stderr path = //p' <<<"$launchctl_output" | head -n 1)"
  pid="$(sed -n 's/^[[:space:]]*pid = //p' <<<"$launchctl_output" | head -n 1)"
  run_interval="$(sed -n 's/^[[:space:]]*run interval = //p' <<<"$launchctl_output" | head -n 1)"

  if [[ "$state" == "not running" && -n "$run_interval" ]]; then
    agent_mode="idle between scheduled runs"
  else
    agent_mode="active"
  fi

  print_summary_field "installed" "$PLIST_TARGET"
  print_summary_field "label" "$LABEL"
  print_summary_field "domain" "$DOMAIN"
  print_summary_field "state" "${state:-unknown}"
  print_summary_field "agent mode" "$agent_mode"
  print_summary_field "pid" "${pid:-n/a}"
  print_summary_field "last exit" "${last_exit_code:-n/a}"
  print_summary_field "interval" "${run_interval:-n/a}"
  print_summary_field "workdir" "${working_directory:-n/a}"
  print_summary_field "stdout" "${stdout_path:-n/a}"
  print_summary_field "stderr" "${stderr_path:-n/a}"
  if [[ -f "$SCREEN_SCRIPT" ]]; then
    printf 'screen:\n'
    /bin/bash "$SCREEN_SCRIPT" status
  fi
  printf 'verbose:          bash scripts/omen-launchdctl.sh status --verbose\n'
}

main() {
  case "${1:-}" in
    install)
      install_agent
      ;;
    uninstall)
      uninstall_agent
      ;;
    status)
      status_agent "${2:-}"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
