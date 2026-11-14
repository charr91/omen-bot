#!/usr/bin/env bash
# pg_dump configured databases, tar, gpg-encrypt, split under 2 GB, optionally upload to a private GitHub release.
# All host-specific paths and the destination repo must be provided via environment variables.
# Never commit passphrase files or tokens. Never print FEED_TELEGRAM_BOT_TOKEN.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/backup.sh

Required environment:
  BACKUP_REPO   GitHub owner/repo that gh can upload encrypted archives to (private recommended)
  BACKUP_DIR    Directory for dump folders and .tar.gpg / .tar.gpg.part-* archives
  BACKUP_KEY    Path to the gpg symmetric passphrase file (mode 600)
  PGHOST        Postgres host or socket directory
  PGPORT        Postgres port
  PGUSER        Postgres role used for pg_dump / pg_dumpall

Optional environment:
  BACKUP_PREFIX          Archive prefix (default: backup)
  BACKUP_TAG             GitHub release tag (default: db)
  KEEP_LOCAL             Local dump dirs and backup units to keep (default: 28)
  KEEP_REMOTE            Remote backup units with this prefix to keep (default: 14)
  BACKUP_OFFBOX          Set to 0 to skip the gh upload
  BACKUP_DATABASES       Space-separated database names (default: omen smart_money_feed)
  BACKUP_SPLIT_BYTES     split -b size (default: 1900m, under GitHub's 2 GB asset limit)
  FEED_TELEGRAM_BOT_TOKEN   If set, alert this bot on dump/upload failure (never printed)
  FEED_TELEGRAM_CHAT_ID     Telegram chat id (default: 7182973735)
  BACKUP_ALERT_TEST      Set to 1 to send one 🧪 TEST backup-alert message and exit
USAGE
}

now() { date +%Y-%m-%dT%H:%M:%S%z; }
dropn() { awk -v k="$1" '{a[NR]=$0} END{for(i=1;i<=NR-k;i++)print a[i]}'; }  # portable `head -n -k` (GNU + BSD)

# Strip a legacy .tar.gpg or split .tar.gpg.part-xx suffix to the backup unit stem
# (e.g. mac-db-20261113-171419).
backup_stem_from_name() {
  sed -E 's/\.tar\.gpg(\.part-[a-z][a-z])?$//'
}

TELEGRAM_CHAT_ID="${FEED_TELEGRAM_CHAT_ID:-7182973735}"

# Send a failure (or test) alert. Never echoes the token or the request URL.
notify_backup_failure() {
  local step="$1"
  local err="$2"
  local token="${FEED_TELEGRAM_BOT_TOKEN:-}"
  local text
  if [ "${BACKUP_ALERT_TEST:-}" = 1 ]; then
    text="🧪 TEST backup-alert
⚠️ omen backup failed on Mac: ${step} ${err}"
  else
    text="⚠️ omen backup failed on Mac: ${step} ${err}"
  fi
  if [ -z "$token" ]; then
    echo "$(now) backup failed at ${step}: ${err} (FEED_TELEGRAM_BOT_TOKEN unset; skipped Telegram alert)" >&2
    return 1
  fi
  if curl -fsS -X POST "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${text}" \
      >/dev/null 2>&1; then
    echo "$(now) sent Telegram backup failure alert (${step})"
    return 0
  fi
  echo "$(now) failed to send Telegram backup failure alert (${step})" >&2
  return 1
}

if [ "${BACKUP_ALERT_TEST:-}" = 1 ]; then
  notify_backup_failure "alert-test" "deliberate dry failure"
  exit 0
fi

for var in BACKUP_REPO BACKUP_DIR BACKUP_KEY PGHOST PGPORT PGUSER; do
  if [ -z "${!var:-}" ]; then
    printf 'error: %s must be set\n\n' "$var" >&2
    usage >&2
    exit 1
  fi
done

if [ ! -f "$BACKUP_KEY" ]; then
  printf 'error: BACKUP_KEY file not found: %s\n' "$BACKUP_KEY" >&2
  exit 1
fi

OUT="$BACKUP_DIR"
KEY="$BACKUP_KEY"
KEEP_LOCAL="${KEEP_LOCAL:-28}"
KEEP_REMOTE="${KEEP_REMOTE:-14}"
TAG="${BACKUP_TAG:-db}"
PREFIX="${BACKUP_PREFIX:-backup}"
DATABASES="${BACKUP_DATABASES:-omen smart_money_feed}"
SPLIT_BYTES="${BACKUP_SPLIT_BYTES:-1900m}"
export PGHOST PGPORT PGUSER

STEP="init"
on_err() {
  local code=$?
  notify_backup_failure "$STEP" "exit ${code}" || true
  exit "$code"
}
trap on_err ERR

TS="$(date +%Y%m%d-%H%M%S)"; DIR="$OUT/$TS"; umask 077; mkdir -p "$DIR"

STEP="dump"
# shellcheck disable=SC2086
for db in $DATABASES; do pg_dump -Fc -d "$db" -f "$DIR/$db.dump"; done
pg_dumpall --roles-only -f "$DIR/roles.sql"

STEP="encrypt"
ARCH="$OUT/$PREFIX-$TS.tar.gpg"
tar -C "$OUT" -cf - "$TS" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$KEY" \
  --symmetric --cipher-algo AES256 -o "$ARCH"

STEP="split"
PART_PREFIX="${ARCH}.part-"
# Remove any leftover parts from a previous attempt with the same timestamp.
for leftover in "$PART_PREFIX"*; do
  [ -e "$leftover" ] || continue
  rm -f "$leftover"
done
split -b "$SPLIT_BYTES" "$ARCH" "$PART_PREFIX"
PARTS=()
for part in "$PART_PREFIX"*; do
  [ -f "$part" ] || continue
  PARTS+=("$part")
done
if [ ${#PARTS[@]} -eq 0 ]; then
  echo "$(now) error: split produced no parts for $ARCH" >&2
  exit 1
fi
rm -f "$ARCH"
echo "$(now) local $DIR ($(du -sh "$DIR" | cut -f1)), encrypted ${#PARTS[@]} part(s): $(printf '%s ' "${PARTS[@]##*/}")"

# Local rotation: newest $KEEP_LOCAL dump dirs and backup units (all parts of a unit together).
STEP="prune-local"
ls -1d "$OUT"/2*/ 2>/dev/null | sort | dropn "$KEEP_LOCAL" | while IFS= read -r p; do
  [ -n "$p" ] || continue
  rm -rf "$p"
done

{
  for f in "$OUT"/"$PREFIX"-*.tar.gpg "$OUT"/"$PREFIX"-*.tar.gpg.part-*; do
    [ -e "$f" ] || continue
    basename "$f" | backup_stem_from_name
  done
} | sort -u | dropn "$KEEP_LOCAL" | while IFS= read -r stem; do
  [ -n "$stem" ] || continue
  rm -f "$OUT/${stem}.tar.gpg"
  for part in "$OUT/${stem}.tar.gpg.part-"*; do
    [ -e "$part" ] || continue
    rm -f "$part"
  done
done

[ "${BACKUP_OFFBOX:-1}" = 1 ] || exit 0

STEP="upload"
gh repo view "$BACKUP_REPO" >/dev/null 2>&1 || gh repo create "$BACKUP_REPO" --private \
  --description "Encrypted DB backups (gpg symmetric)" --add-readme >/dev/null
gh release view "$TAG" -R "$BACKUP_REPO" >/dev/null 2>&1 || gh release create "$TAG" -R "$BACKUP_REPO" \
  --title "DB backups" --notes "gpg-encrypted pg_dump archives, split under 2 GB; newest $KEEP_REMOTE backup units kept" >/dev/null
gh release upload "$TAG" "${PARTS[@]}" -R "$BACKUP_REPO" --clobber

STEP="prune-remote"
# Collect remote asset names once, group into stems, drop oldest units, delete every part (or legacy file) of each.
remote_assets="$(gh release view "$TAG" -R "$BACKUP_REPO" --json assets -q '.assets[].name' || true)"
printf '%s\n' "$remote_assets" | { grep "^$PREFIX-" || true; } | backup_stem_from_name | sort -u | dropn "$KEEP_REMOTE" | while IFS= read -r stem; do
  [ -n "$stem" ] || continue
  printf '%s\n' "$remote_assets" | { grep -E "^${stem}\\.tar\\.gpg\$|^${stem}\\.tar\\.gpg\\.part-[a-z][a-z]\$" || true; } | while IFS= read -r a; do
    [ -n "$a" ] || continue
    gh release delete-asset "$TAG" "$a" -R "$BACKUP_REPO" -y
  done
done

echo "$(now) uploaded $(printf '%s ' "${PARTS[@]##*/}")to $BACKUP_REPO release $TAG"
