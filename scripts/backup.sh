#!/usr/bin/env bash
# pg_dump omen + smart_money_feed to /workspace/backups (local rotation), then upload a gpg-encrypted copy off-box
# as release assets on the private GitHub repo $BACKUP_REPO (release tag "db"), keeping the newest $KEEP_REMOTE.
# Symmetric AES256 passphrase: /workspace/data/backup.key (never committed). See docs/box-dry-run.md.
set -euo pipefail
OUT="${BACKUP_DIR:-/workspace/backups}"; KEY="${BACKUP_KEY:-/workspace/data/backup.key}"
KEEP_LOCAL="${KEEP_LOCAL:-28}"; KEEP_REMOTE="${KEEP_REMOTE:-14}"
BACKUP_REPO="${BACKUP_REPO:-charr91/omen-box-backups}"; TAG=db
PGHOST="${PGHOST:-/workspace/data/pg}"; PGPORT="${PGPORT:-5433}"; PGUSER="${PGUSER:-postgres}"; export PGHOST PGPORT PGUSER
TS="$(date +%Y%m%d-%H%M%S)"; DIR="$OUT/$TS"; umask 077; mkdir -p "$DIR"
for db in omen smart_money_feed; do pg_dump -Fc -d "$db" -f "$DIR/$db.dump"; done
pg_dumpall --roles-only -f "$DIR/roles.sql"
ARCH="$OUT/box-db-$TS.tar.gpg"
tar -C "$OUT" -cf - "$TS" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$KEY" \
  --symmetric --cipher-algo AES256 -o "$ARCH"
echo "$(date -Is) local $DIR ($(du -sh "$DIR" | cut -f1)), encrypted $ARCH"
# local rotation: newest $KEEP_LOCAL dump dirs and archives
ls -1d "$OUT"/2*/ 2>/dev/null | sort | head -n -"$KEEP_LOCAL" | xargs -r rm -rf
ls -1 "$OUT"/box-db-*.tar.gpg 2>/dev/null | sort | head -n -"$KEEP_LOCAL" | xargs -r rm -f
[ "${BACKUP_OFFBOX:-1}" = 1 ] || exit 0
gh repo view "$BACKUP_REPO" >/dev/null 2>&1 || gh repo create "$BACKUP_REPO" --private \
  --description "Encrypted box DB backups (gpg symmetric)" --add-readme >/dev/null
gh release view "$TAG" -R "$BACKUP_REPO" >/dev/null 2>&1 || gh release create "$TAG" -R "$BACKUP_REPO" \
  --title "DB backups" --notes "gpg-encrypted pg_dump archives; newest $KEEP_REMOTE kept" >/dev/null
gh release upload "$TAG" "$ARCH" -R "$BACKUP_REPO" --clobber
gh release view "$TAG" -R "$BACKUP_REPO" --json assets -q '.assets[].name' | grep '^box-db-' | sort | head -n -"$KEEP_REMOTE" |
  while read -r a; do gh release delete-asset "$TAG" "$a" -R "$BACKUP_REPO" -y; done
echo "$(date -Is) uploaded $(basename "$ARCH") to $BACKUP_REPO release $TAG"
