# Running omen on a server

This is a generic outline. Do not commit `.env` files, passphrase files, or API keys.

1. Install Node 22+, pnpm, Postgres, and Redis. Copy `.env.example` to `.env` and set `DATABASE_URL`, `REDIS_URL`, and `ALCHEMY_API_KEY` as needed.
2. Start omen with `pnpm exec tsx src/cli.ts start` (or `start --tui`). A process manager of your choice (systemd, launchd, screen) can keep it up. Helper scripts live under `scripts/`.
3. Set `[operational] dry_run = true` in `omen.config.toml` until you intend to send alerts. Telegram/Discord stay silent if their env vars are blank.
4. The optional `@charr91/smart-money-feed` package publishes alerts to a sibling feed process when it is installed and `FEED_DATABASE_URL` is set. Without that package, omen still runs; feed publish/X-bridge calls no-op.
5. Encrypted database backups: `scripts/backup.sh` (and the thin `scripts/mac-backup.sh` wrapper) require environment variables and fail if they are unset:

   - `BACKUP_REPO` — GitHub `owner/repo` that `gh` can upload archives to
   - `BACKUP_DIR` — local dump and archive directory
   - `BACKUP_KEY` — path to the gpg passphrase file (mode 600; keep a copy offline)
   - `PGHOST`, `PGPORT`, `PGUSER` — Postgres connection
   - optional: `BACKUP_PREFIX`, `BACKUP_TAG`, `KEEP_LOCAL`, `KEEP_REMOTE`, `BACKUP_OFFBOX`, `BACKUP_DATABASES`, `BACKUP_PATH_PREFIX` (prepended to `PATH` by `mac-backup.sh`)
