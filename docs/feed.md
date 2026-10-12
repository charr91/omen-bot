# Shared alert feed (M3)

omen publishes to the shared layer in **charr91/smart-money-feed**, installed as a git dependency pinned to a tag.
Its README covers the design and decision #11 (a library writing to a shared schema, plus one dispatcher process).

- **Settings:** `[feed] enabled` in omen.config.toml, and `FEED_DATABASE_URL` in .env, pointing at a separate
  database (`smart_money_feed` on the box). omen never reads that database back.
- **Live alerts:** every promoted alert is published with `deliver=true`, keyed by fill id. The feed process owns
  Telegram and is in dry run unless `FEED_DRY_RUN=false` and a bot token and chat id are set. A publish failure only
  logs `[feed] publish failed` and never blocks omen.
- **Outcomes:** after each outcome-tracker run, new or changed `trade_outcomes` rows (Polymarket and Kalshi, signals
  and baselines) are mirrored as envelopes (`deliver=false`) plus `feed.outcomes`. `trade_outcomes.feed_synced_at`
  tracks progress.
- **Parity:** `smart-money-feed stats --app omen` matches `omen stats` (same hit definition, flat moves excluded).
- **Before going live:** omen's own Telegram/Discord channels still deliver promoted alerts too. Turn them off (or
  set `publish_live_alerts = false`) so each alert reaches Telegram only once.
