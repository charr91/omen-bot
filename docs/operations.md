# Running omen on a server

This is a generic outline. Do not commit `.env` files, passphrase files, or API keys.

1. Install Node 22+, pnpm, Postgres, and Redis. Copy `.env.example` to `.env` and set `DATABASE_URL`, `REDIS_URL`, and `ALCHEMY_API_KEY` as needed.
2. Start omen with `pnpm exec tsx src/cli.ts start` (or `start --tui`). A process manager of your choice (systemd, launchd, screen) can keep it up. Helper scripts live under `scripts/`.
3. Set `[operational] dry_run = true` in `omen.config.toml` until you intend to send alerts. Telegram/Discord stay silent if their env vars are blank.
4. The optional `@charr91/smart-money-feed` package publishes alerts to a sibling feed process when it is installed and `FEED_DATABASE_URL` is set. Without that package, omen fails fast at startup unless you opt into the local no-op shim with `OMEN_FEED_SHIM=1` (tests do this automatically). The shim must not be used in production.
5. Encrypted database backups: `scripts/backup.sh` (and the thin `scripts/mac-backup.sh` wrapper) require environment variables and fail if they are unset:

   - `BACKUP_REPO` — GitHub `owner/repo` that `gh` can upload archives to
   - `BACKUP_DIR` — local dump and archive directory
   - `BACKUP_KEY` — path to the gpg passphrase file (mode 600; keep a copy offline)
   - `PGHOST`, `PGPORT`, `PGUSER` — Postgres connection
   - optional: `BACKUP_PREFIX`, `BACKUP_TAG`, `KEEP_LOCAL`, `KEEP_REMOTE`, `BACKUP_OFFBOX`, `BACKUP_DATABASES`, `BACKUP_PATH_PREFIX` (prepended to `PATH` by `mac-backup.sh`)
   - optional alerts: on dump/upload failure, `backup.sh` can send a Telegram message if `FEED_TELEGRAM_BOT_TOKEN` is set (chat default `7182973735`, or `FEED_TELEGRAM_CHAT_ID`). `mac-backup.sh` will load those vars from `FEED_ENV_FILE` or a sibling `smart-money-feed/.env` without printing them. `BACKUP_ALERT_TEST=1` sends one test message and exits.

   Archives are split under 2 GB (`split -b 1900m`) into assets named `<prefix>-<ts>.tar.gpg.part-aa`, `part-ab`, and so on. All parts of a backup are uploaded and pruned as one unit (keep 14 remote, 28 local). Legacy single-file `<prefix>-<ts>.tar.gpg` assets remain restorable.

   Restore (new split assets — concatenate parts before decrypt):

   ```bash
   gh release download "$BACKUP_TAG" -R "$BACKUP_REPO" -p "$BACKUP_PREFIX-<ts>.tar.gpg.part-*"
   # or: scripts/restore-backup.sh --extract-dir /tmp/restore "$BACKUP_PREFIX-<ts>.tar.gpg.part-aa"
   cat "$BACKUP_PREFIX-<ts>.tar.gpg.part-"* | gpg --batch --pinentry-mode loopback --passphrase-file "$BACKUP_KEY" -d | tar -xf -
   ```

   Restore (legacy single-file assets):

   ```bash
   gh release download "$BACKUP_TAG" -R "$BACKUP_REPO" -p "$BACKUP_PREFIX-<ts>.tar.gpg"
   gpg --batch --pinentry-mode loopback --passphrase-file "$BACKUP_KEY" -d "$BACKUP_PREFIX-<ts>.tar.gpg" | tar -xf -
   ```

   Then restore a dump into a scratch database (do not overwrite a live database):

   ```bash
   psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -c 'create database restore_test'
   pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d restore_test --no-owner <ts>/omen.dump
   # inspect, then:
   psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -c 'drop database restore_test'
   ```

   `scripts/restore-backup.sh` accepts either a legacy `.tar.gpg` file or any split part and handles concatenation.
