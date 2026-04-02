#!/usr/bin/env bash

set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/bot/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SESSION_NAME="${OMEN_SCREEN_SESSION:-omen}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOP_TIMEOUT_SECONDS="${OMEN_SCREEN_STOP_TIMEOUT_SECONDS:-30}"

usage() {
  cat <<'EOF'
Usage:
  scripts/omen-screen.sh start
  scripts/omen-screen.sh attach
  scripts/omen-screen.sh attach --verbose
  scripts/omen-screen.sh is-running
  scripts/omen-screen.sh stop
  scripts/omen-screen.sh status [--verbose]

Environment:
  OMEN_SCREEN_SESSION   Override the screen session name (default: omen)
  OMEN_SCREEN_STOP_TIMEOUT_SECONDS
                        Seconds to wait for graceful shutdown before forcing quit (default: 30)
EOF
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
}

screen_outer_term() {
  local current_term="${TERM:-}"

  if [[ -z "$current_term" || ${#current_term} -gt 20 ]]; then
    printf 'xterm-256color'
    return
  fi

  if ! infocmp "$current_term" >/dev/null 2>&1; then
    printf 'xterm-256color'
    return
  fi

  printf '%s' "$current_term"
}

run_screen() {
  local compat_term
  compat_term="$(screen_outer_term)"
  TERM="$compat_term" screen "$@"
}

screen_list_output() {
  run_screen -list 2>/dev/null || true
}

session_line() {
  local screen_output
  screen_output="$(screen_list_output)"
  grep -E "[[:space:]][0-9]+\.${SESSION_NAME}[[:space:]]" <<<"$screen_output" | grep -Fv '(Dead ???)' | head -n 1
}

session_id() {
  local line
  line="$(session_line)"
  sed -E 's/^[[:space:]]*([0-9]+\.[^[:space:]]+).*/\1/' <<<"$line"
}

has_screen_ancestor() {
  local pid="${PPID:-}"

  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" ]]; do
    local comm
    comm="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    case "$comm" in
      screen|SCREEN)
        return 0
        ;;
    esac

    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  done

  return 1
}

session_exists() {
  [[ -n "$(session_line)" ]]
}

start_session() {
  require_command screen
  require_command docker
  require_command pnpm
  require_command zsh

  if session_exists; then
    printf 'screen session "%s" is already running\n' "$SESSION_NAME"
    printf 'attach with: screen -r %s\n' "$SESSION_NAME"
    return
  fi

  (
    cd "$REPO_ROOT"
    docker compose up -d --wait
  )

  local run_command
  printf -v run_command 'cd %q && exec pnpm exec tsx src/cli.ts start --tui' "$REPO_ROOT"

  run_screen -dmS "$SESSION_NAME" zsh -lc "$run_command"

  printf 'started omen in screen session "%s"\n' "$SESSION_NAME"
  printf 'attach with: screen -r %s\n' "$SESSION_NAME"
  printf 'detach with: Ctrl-a d\n'
}

attach_session() {
  local verbose="${1:-}"
  require_command screen

  if [[ -n "$verbose" && "$verbose" != "--verbose" ]]; then
    printf 'unsupported attach option: %s\n' "$verbose" >&2
    printf 'run `screen -wipe` separately, then rerun attach\n' >&2
    exit 1
  fi

  if ! session_exists; then
    printf 'screen session "%s" is not running\n' "$SESSION_NAME" >&2
    exit 1
  fi

  local current_sty active_session_id
  current_sty="${STY:-}"
  active_session_id="$(session_id)"
  if has_screen_ancestor && [[ -n "$current_sty" ]] && [[ "$current_sty" == "$active_session_id" || "$current_sty" == *".${SESSION_NAME}" ]]; then
    printf 'already inside screen session "%s" (%s)\n' "$SESSION_NAME" "$current_sty"
    printf 'detach:           Ctrl-a d\n'
    return
  fi

  if [[ "$verbose" == "--verbose" ]]; then
    printf 'attaching to screen session "%s"\n' "$SESSION_NAME"
    if [[ -n "$current_sty" ]]; then
      printf 'note: ignoring inherited screen environment (%s) before reattach\n' "$current_sty"
    fi
  fi

  exec env -u STY -u WINDOW -u TERMCAP TERM="$(screen_outer_term)" screen -D -R "$SESSION_NAME"
}

is_running_session() {
  require_command screen

  if session_exists; then
    exit 0
  fi

  exit 1
}

stop_session() {
  require_command screen

  if ! session_exists; then
    printf 'screen session "%s" is not running\n' "$SESSION_NAME"
    return
  fi

  run_screen -S "$SESSION_NAME" -X stuff $'q'
  local waited_seconds=0
  while session_exists && (( waited_seconds < STOP_TIMEOUT_SECONDS )); do
    sleep 1
    waited_seconds=$((waited_seconds + 1))
  done

  if session_exists; then
    printf 'screen session "%s" did not stop within %ss; forcing quit\n' "$SESSION_NAME" "$STOP_TIMEOUT_SECONDS"
    run_screen -S "$SESSION_NAME" -X quit
  fi

  printf 'stopped screen session "%s"\n' "$SESSION_NAME"
}

status_session() {
  local verbose="${1:-}"
  require_command screen

  if [[ -n "$verbose" && "$verbose" != "--verbose" ]]; then
    printf 'unsupported status option: %s\n' "$verbose" >&2
    exit 1
  fi

  if session_exists; then
    local line state screen_output
    screen_output="$(screen_list_output)"
    line="$(session_line)"
    state="$(sed -E 's/.*\(([^)]+)\).*/\1/' <<<"$line")"

    if [[ "$verbose" == "--verbose" ]]; then
      printf 'running: screen session "%s"\n' "$SESSION_NAME"
      printf '%s\n' "$screen_output"
      return
    fi

    printf 'running: screen session "%s" (%s)\n' "$SESSION_NAME" "${state:-unknown}"
    if has_screen_ancestor && [[ -n "${STY:-}" ]]; then
      printf 'current shell:    inside screen (%s)\n' "$STY"
    elif [[ -n "${STY:-}" ]]; then
      printf 'current shell:    stale screen env detected (%s)\n' "$STY"
    fi
    printf 'attach:           pnpm run omen:screen:attach\n'
    printf 'detach:           Ctrl-a d\n'
    if grep -Fq '(Dead ???)' <<<"$screen_output"; then
      printf 'cleanup:          screen -wipe\n'
    fi
    return
  fi

  printf 'not running: screen session "%s"\n' "$SESSION_NAME"
}

main() {
  local command="${1:-}"

  case "$command" in
    start)
      start_session
      ;;
    attach)
      attach_session "${2:-}"
      ;;
    is-running)
      is_running_session
      ;;
    stop)
      stop_session
      ;;
    status)
      status_session "${2:-}"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
