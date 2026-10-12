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
- **Legacy channels:** `[feed] disable_legacy_channels = true` (default false) drops omen's own Telegram/Discord
  channels, so the feed process is the only delivery path. It takes effect only while `enabled`,
  `FEED_DATABASE_URL` and `publish_live_alerts` are all on; otherwise the legacy channels stay so alerts are never
  silently dropped. Alerts are still stored and shown on the dashboard. Without it, both paths deliver, so turn one
  off before going live.
