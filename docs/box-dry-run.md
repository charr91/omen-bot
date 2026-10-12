# Headless dry run on a Linux box

`scripts/box-run.sh start|stop|status` runs `omen start` headless (no TUI) with
`OMEN_OPERATIONAL_DRY_RUN=true` forced, so no Telegram/Discord alerts are sent.
Logs go to `logs/omen-<timestamp>.log` (gitignored), with `logs/omen.log` pointing
at the latest run.

`.env` (gitignored) for a box run:

```
DATABASE_URL=postgresql://omen:omen@localhost:5432/omen
REDIS_URL=redis://localhost:6379
ALCHEMY_API_KEY=...            # optional, see below
OMEN_OPERATIONAL_DRY_RUN=true
LOG_PRETTY=false
# leave all TELEGRAM_* / DISCORD_* blank
```

`OMEN_ALLOW_MISSING_ALCHEMY=true` lets `start` run without `ALCHEMY_API_KEY`.
Every wallet profile then uses the conservative fallback and funding-graph jobs
fail with a cooldown, so wallet-based signals cannot fire.

`stop` sends SIGTERM to the CLI, which stops ingestion, finishes the in-flight
fill (queued fills stay unanalyzed and are replayed on next start), stops the
cold-worker child and exits. If anything is still alive after 90s, the process
group is SIGKILLed.

## Alchemy budget knobs (`[alchemy]` in omen.config.toml)

| key | default | env override | purpose |
|---|---|---|---|
| hot_cu_per_second | 120 (code default 200) | OMEN_ALCHEMY_HOT_CU_PER_SECOND | hot-worker token bucket |
| cold_cu_per_second | 160 (code default 80) | OMEN_ALCHEMY_COLD_CU_PER_SECOND | funding-graph token bucket |
| max_wait_ms | 20000 | OMEN_ALCHEMY_MAX_WAIT_MS | max wait for capacity before a request is rejected |
| max_queue | 500 | n/a | max waiters per bucket |
| max_429_retries | 3 | n/a | retries on HTTP 429 (honours Retry-After) |
| min_profile_fill_usd | 200 | OMEN_ALCHEMY_MIN_PROFILE_FILL_USD | fills below this skip profiling and funding-graph rebuilds (capped at the lowest signal min_fill_usd) |
| profile_cache_ttl_ms | 43200000 | OMEN_ALCHEMY_PROFILE_CACHE_TTL_MS | wallet and controller profile cache TTL (12h) |
| daily_cu_budget | 1000000 | OMEN_ALCHEMY_DAILY_CU_BUDGET | CU per UTC day (about 30M/month); 0 = unlimited |
| hot_budget_share | 0.4 | n/a | hot worker's share; the cold path gets the rest |

Hot + cold = 280 CU/s, under the 330 CU/s free-tier limit.

## Proxy controller attribution

Polymarket proxy wallets are funded with USDC/USDC.e/pUSD, not POL. The
controller (owner EOA) is read on-chain: `owner()` for beacon-proxy deposit
wallets, Gnosis Safe owner storage for Safes, `isOwner()` checks against the
first inbound funders, and finally a single unique inbound sender. The wallet's
age is then the controller's age.

## Cold path

Funding-graph jobs are deduped per wallet. When a job runs, it completes without any
Alchemy calls if the wallet's graph is younger than 24h or the wallet has no fill
>= `min_profile_fill_usd` in the last 24h (`status: "skipped"` in the log).
`[cold_path] concurrency = 2`.

## Alchemy CU usage

Every metered Alchemy call adds its CU weight to the Redis hash
`omen:alchemy:cu:<YYYY-MM-DD UTC>` (fields `hot`, `cold`; kept 40 days). Each
`runtime-stats` log line carries `alchemyCu` (today's total, per component, and a
30-day projection), and an `alchemy-cu-daily` line is logged after each UTC day ends.
Once a component reaches its share, the hot worker serves cached profiles and gives
uncached wallets the conservative profile (fresh-wallet signals can't fire), and the cold
path skips rebuilds (`reason: "daily-budget"`) until 00:00 UTC.
Check it by hand with `redis-cli hgetall omen:alchemy:cu:$(date -u +%F)`.
