#!/usr/bin/env bash
# pg_dump configured databases, tar, gpg-encrypt, optionally upload to a private GitHub release.
# All host-specific paths and the destination repo must be provided via environment variables.
# Never commit passphrase files or tokens.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/backup.sh

Required environment:
  BACKUP_REPO   GitHub owner/repo that gh can upload encrypted archives to (private recommended)
  BACKUP_DIR    Directory for dump folders and .tar.gpg archives
  BACKUP_KEY    Path to the gpg symmetric passphrase file (mode 600)
  PGHOST        Postgres host or socket directory
  PGPORT        Postgres port
  PGUSER        Postgres role used for pg_dump / pg_dumpall

Optional environment:
  BACKUP_PREFIX   Archive prefix (default: backup)
  BACKUP_TAG      GitHub release tag (default: db)
  KEEP_LOCAL      Local dump dirs and archives to keep (default: 28)
  KEEP_REMOTE     Remote release assets with this prefix to keep (default: 14)
  BACKUP_OFFBOX   Set to 0 to skip the gh upload
  BACKUP_DATABASES  Space-separated database names (default: omen smart_money_feed)
USAGE
}

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
export PGHOST PGPORT PGUSER

dropn() { awk -v k="$1" '{a[NR]=$0} END{for(i=1;i<=NR-k;i++)print a[i]}'; }  # portable `head -n -k` (GNU + BSD)
now() { date +%Y-%m-%dT%H:%M:%S%z; }
TS="$(date +%Y%m%d-%H%M%S)"; DIR="$OUT/$TS"; umask 077; mkdir -p "$DIR"
# shellcheck disable=SC2086
for db in $DATABASES; do pg_dump -Fc -d "$db" -f "$DIR/$db.dump"; done
pg_dumpall --roles-only -f "$DIR/roles.sql"
ARCH="$OUT/$PREFIX-$TS.tar.gpg"
tar -C "$OUT" -cf - "$TS" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$KEY" \
  --symmetric --cipher-algo AES256 -o "$ARCH"
echo "$(now) local $DIR ($(du -sh "$DIR" | cut -f1)), encrypted $ARCH"
# local rotation: newest $KEEP_LOCAL dump dirs and archives
ls -1d "$OUT"/2*/ 2>/dev/null | sort | dropn "$KEEP_LOCAL" | xargs -r rm -rf
ls -1 "$OUT"/"$PREFIX"-*.tar.gpg 2>/dev/null | sort | dropn "$KEEP_LOCAL" | xargs -r rm -f
[ "${BACKUP_OFFBOX:-1}" = 1 ] || exit 0
gh repo view "$BACKUP_REPO" >/dev/null 2>&1 || gh repo create "$BACKUP_REPO" --private \
  --description "Encrypted DB backups (gpg symmetric)" --add-readme >/dev/null
gh release view "$TAG" -R "$BACKUP_REPO" >/dev/null 2>&1 || gh release create "$TAG" -R "$BACKUP_REPO" \
  --title "DB backups" --notes "gpg-encrypted pg_dump archives; newest $KEEP_REMOTE kept" >/dev/null
gh release upload "$TAG" "$ARCH" -R "$BACKUP_REPO" --clobber
gh release view "$TAG" -R "$BACKUP_REPO" --json assets -q '.assets[].name' | { grep "^$PREFIX-" || true; } | sort | dropn "$KEEP_REMOTE" |
  while read -r a; do gh release delete-asset "$TAG" "$a" -R "$BACKUP_REPO" -y; done
echo "$(now) uploaded $(basename "$ARCH") to $BACKUP_REPO release $TAG"
