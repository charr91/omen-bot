#!/usr/bin/env bash
# Decrypt and extract an omen encrypted backup.
# Accepts a legacy single-file <name>.tar.gpg or any split part <name>.tar.gpg.part-aa (concatenated before decrypt).
# Optional: restore one dump into a scratch database (never the default live names unless you pass them explicitly).
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/restore-backup.sh [options] ARCHIVE_OR_PART

ARCHIVE_OR_PART may be:
  a legacy single-file asset:  mac-db-20261113-171419.tar.gpg
  any split part:              mac-db-20261114-010203.tar.gpg.part-aa
  a stem or prefix:            mac-db-20261114-010203
                               (resolves sibling .part-* files, or a legacy .tar.gpg)

Options:
  --extract-dir DIR   Directory to extract the dump folder into (default: a temp dir, printed)
  --key FILE          gpg passphrase file (default: BACKUP_KEY)
  --restore-db NAME   Create this database if needed and pg_restore --no-owner the chosen dump
  --dump NAME         Dump file inside the archive (default: omen.dump)
  --keep-extract      Do not delete the extract directory on exit
  -h, --help          Show this help

Postgres connection comes from PGHOST, PGPORT, PGUSER when --restore-db is used.
This script will refuse --restore-db omen or smart_money_feed unless ALLOW_LIVE_DB_RESTORE=1.
Verification of --restore-db counts relations in any non-system schema (not only public),
and also requires objects in the expected schema for known dumps (omen.dump -> public,
smart_money_feed.dump -> feed).
USAGE
}

# Maps a dump filename to the schema that should hold restored objects.
# Unknown dumps return empty: any non-system schema is accepted.
expected_schema_for_dump() {
  case "$1" in
    smart_money_feed.dump) printf '%s\n' feed ;;
    omen.dump) printf '%s\n' public ;;
    *) printf '%s\n' ;;
  esac
}

# Count relations in every schema except Postgres system catalogs.
user_relation_count_sql() {
  cat <<'SQL'
SELECT count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname NOT LIKE 'pg_temp%'
  AND n.nspname NOT LIKE 'pg_toast_temp%'
SQL
}

# Count relations in one schema (caller must pass a simple identifier).
schema_relation_count_sql() {
  printf "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '%s'\n" "$1"
}

# Allow unit tests to source the helpers without running the CLI.
if [ "${RESTORE_BACKUP_SOURCE_ONLY:-}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi

EXTRACT_DIR=""
KEY="${BACKUP_KEY:-}"
RESTORE_DB=""
DUMP_NAME="omen.dump"
KEEP_EXTRACT=0
INPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --extract-dir) EXTRACT_DIR="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --restore-db) RESTORE_DB="$2"; shift 2 ;;
    --dump) DUMP_NAME="$2"; shift 2 ;;
    --keep-extract) KEEP_EXTRACT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) echo "error: unknown option $1" >&2; usage >&2; exit 1 ;;
    *) INPUT="$1"; shift; break ;;
  esac
done
if [ -z "$INPUT" ] && [ $# -gt 0 ]; then
  INPUT="$1"
  shift
fi
if [ -z "$INPUT" ]; then
  usage >&2
  exit 1
fi
if [ -z "$KEY" ] || [ ! -f "$KEY" ]; then
  echo "error: passphrase file not found (set BACKUP_KEY or pass --key)" >&2
  exit 1
fi
if [ -n "$RESTORE_DB" ]; then
  case "$RESTORE_DB" in
    omen|smart_money_feed)
      if [ "${ALLOW_LIVE_DB_RESTORE:-}" != 1 ]; then
        echo "error: refusing to restore into live database '$RESTORE_DB' (set ALLOW_LIVE_DB_RESTORE=1 to override)" >&2
        exit 1
      fi
      ;;
  esac
  for var in PGHOST PGPORT PGUSER; do
    if [ -z "${!var:-}" ]; then
      printf 'error: %s must be set when using --restore-db\n' "$var" >&2
      exit 1
    fi
  done
  export PGHOST PGPORT PGUSER
fi

# Resolve INPUT to either one legacy file or a sorted list of split parts.
resolve_sources() {
  local arg="$1"
  local dir base prefix candidate
  if [ -f "$arg" ]; then
    case "$arg" in
      *.tar.gpg.part-[a-z][a-z])
        dir=$(cd "$(dirname "$arg")" && pwd)
        base=$(basename "$arg")
        prefix="${base%.part-*}"
        # prefix is e.g. mac-db-TS.tar.gpg
        set -- "$dir"/"$prefix".part-*
        if [ ! -f "$1" ]; then
          echo "error: no split parts found next to $arg" >&2
          return 1
        fi
        printf 'parts'
        for candidate in "$dir"/"$prefix".part-*; do
          [ -f "$candidate" ] || continue
          printf ' %s' "$candidate"
        done
        printf '\n'
        return 0
        ;;
      *.tar.gpg)
        # Prefer sibling parts if a split backup also left a combined file around.
        dir=$(cd "$(dirname "$arg")" && pwd)
        base=$(basename "$arg")
        set -- "$dir"/"$base".part-*
        if [ -f "$1" ]; then
          printf 'parts'
          for candidate in "$dir"/"$base".part-*; do
            [ -f "$candidate" ] || continue
            printf ' %s' "$candidate"
          done
          printf '\n'
          return 0
        fi
        printf 'single %s\n' "$dir/$base"
        return 0
        ;;
    esac
  fi

  # Stem or prefix: look in dirname (or cwd) for parts first, then a legacy file.
  if [ -d "$arg" ]; then
    echo "error: expected an archive path, not a directory: $arg" >&2
    return 1
  fi
  dir=$(cd "$(dirname "$arg")" && pwd)
  base=$(basename "$arg")
  base="${base%.tar.gpg}"
  set -- "$dir"/"$base".tar.gpg.part-*
  if [ -f "$1" ]; then
    printf 'parts'
    for candidate in "$dir"/"$base".tar.gpg.part-*; do
      [ -f "$candidate" ] || continue
      printf ' %s' "$candidate"
    done
    printf '\n'
    return 0
  fi
  if [ -f "$dir/${base}.tar.gpg" ]; then
    printf 'single %s\n' "$dir/${base}.tar.gpg"
    return 0
  fi
  echo "error: could not resolve backup archive from: $arg" >&2
  return 1
}

SOURCES="$(resolve_sources "$INPUT")"
set -- $SOURCES
MODE="$1"
shift

CREATED_EXTRACT=0
if [ -z "$EXTRACT_DIR" ]; then
  EXTRACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/omen-restore.XXXXXX")"
  CREATED_EXTRACT=1
else
  mkdir -p "$EXTRACT_DIR"
fi

cleanup() {
  if [ "$KEEP_EXTRACT" = 0 ] && [ "$CREATED_EXTRACT" = 1 ] && [ -n "${EXTRACT_DIR:-}" ]; then
    rm -rf "$EXTRACT_DIR"
  fi
}
if [ "$KEEP_EXTRACT" = 0 ] && [ "$CREATED_EXTRACT" = 1 ] && [ -z "$RESTORE_DB" ]; then
  # Always keep the extract when the caller only asked to unpack and we created the dir —
  # they need to see it. Mark keep in that case and print the path.
  KEEP_EXTRACT=1
fi
trap cleanup EXIT

echo "extracting to $EXTRACT_DIR"
if [ "$MODE" = single ]; then
  gpg --batch --pinentry-mode loopback --passphrase-file "$KEY" -d "$1" | tar -C "$EXTRACT_DIR" -xf -
else
  # "$@" is the sorted list of parts (glob order is lexical: part-aa, part-ab, ...)
  cat "$@" | gpg --batch --pinentry-mode loopback --passphrase-file "$KEY" -d | tar -C "$EXTRACT_DIR" -xf -
fi

if [ -z "$RESTORE_DB" ]; then
  echo "extracted OK. contents:"
  ls -la "$EXTRACT_DIR"/* 2>/dev/null || ls -la "$EXTRACT_DIR"
  exit 0
fi

DUMP=""
# Archive contains a timestamp directory with the dump files.
while IFS= read -r found; do
  DUMP="$found"
  break
done < <(find "$EXTRACT_DIR" -type f -name "$DUMP_NAME" | sort)

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "error: dump $DUMP_NAME not found under $EXTRACT_DIR" >&2
  exit 1
fi

case "$RESTORE_DB" in
  *[!a-zA-Z0-9_]*)
    echo "error: --restore-db must be a simple identifier (letters, digits, underscore)" >&2
    exit 1
    ;;
esac

echo "restoring $DUMP into database $RESTORE_DB (scratch; --no-owner --no-acl)"
if psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$RESTORE_DB'" | grep -q 1; then
  echo "error: database $RESTORE_DB already exists; refusing to overwrite. Drop it first or pick a new name." >&2
  exit 1
fi
psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $RESTORE_DB"
# pg_restore can exit 1 on ignorable warnings (e.g. comment on extension). Fail only if nothing landed.
set +e
pg_restore -d "$RESTORE_DB" --no-owner --no-acl "$DUMP"
restore_rc=$?
set -e
relcount="$(psql -d "$RESTORE_DB" -Atc "$(user_relation_count_sql)")"
echo "pg_restore exit=$restore_rc; user relations=$relcount in $RESTORE_DB"
expected_schema="$(expected_schema_for_dump "$DUMP_NAME")"
if [ -n "$expected_schema" ]; then
  case "$expected_schema" in
    *[!a-zA-Z0-9_]*)
      echo "error: expected schema must be a simple identifier (got: $expected_schema)" >&2
      exit 1
      ;;
  esac
  schema_count="$(psql -d "$RESTORE_DB" -Atc "$(schema_relation_count_sql "$expected_schema")")"
  echo "expected schema $expected_schema relations=$schema_count"
  if [ "${schema_count:-0}" -lt 1 ]; then
    echo "error: restore produced no relations in expected schema '$expected_schema' (from $DUMP_NAME)" >&2
    exit 1
  fi
fi
echo "extract dir: $EXTRACT_DIR"
if [ "${relcount:-0}" -lt 1 ]; then
  echo "error: restore produced no user relations (non-system schemas)" >&2
  exit 1
fi
