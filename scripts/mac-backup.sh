#!/usr/bin/env bash
# Thin wrapper around scripts/backup.sh for a launchd/cron host.
# Host paths, ports, and the destination repo must come from the environment (no hardcoded machine, user, or repo).
# Loads FEED_TELEGRAM_BOT_TOKEN from a sibling feed .env when the var is not already set; never prints the token.
set -euo pipefail

if [ -n "${BACKUP_PATH_PREFIX:-}" ]; then
  export PATH="$BACKUP_PATH_PREFIX:$PATH"
fi

# Pull only Telegram alert credentials from a dotenv file (no `set -x`, values never echoed).
load_feed_telegram_env() {
  local file="$1"
  local line key value
  [ -n "$file" ] && [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    case "$key" in
      FEED_TELEGRAM_BOT_TOKEN|FEED_TELEGRAM_CHAT_ID)
        value="${line#*=}"
        value="${value#\"}"
        value="${value%\"}"
        value="${value#\'}"
        value="${value%\'}"
        # Only fill a var if it is not already in the environment.
        if [ -z "${!key:-}" ]; then
          export "$key=$value"
        fi
        ;;
    esac
  done < "$file"
}

if [ -z "${FEED_TELEGRAM_BOT_TOKEN:-}" ]; then
  feed_env_file="${FEED_ENV_FILE:-}"
  if [ -z "$feed_env_file" ]; then
    repo_root="$(cd "$(dirname "$0")/.." && pwd)"
    if [ -f "$repo_root/../smart-money-feed/.env" ]; then
      feed_env_file="$repo_root/../smart-money-feed/.env"
    fi
  fi
  if [ -n "$feed_env_file" ]; then
    load_feed_telegram_env "$feed_env_file"
  fi
fi

exec "$(dirname "$0")/backup.sh"
