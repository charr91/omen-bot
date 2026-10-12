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

`stop` sends SIGTERM to the process group, then SIGKILL after 60s, because
SIGTERM shutdown of `start` does not complete cleanly yet (known issue).

## Alchemy budget knobs (`[alchemy]` in omen.config.toml)

| key | default | env override | purpose |
|---|---|---|---|
| hot_cu_per_second | 200 | OMEN_ALCHEMY_HOT_CU_PER_SECOND | hot-worker token bucket |
| cold_cu_per_second | 80 | OMEN_ALCHEMY_COLD_CU_PER_SECOND | funding-graph token bucket |
| max_wait_ms | 20000 | OMEN_ALCHEMY_MAX_WAIT_MS | max wait for capacity before a request is rejected |
| max_queue | 500 | n/a | max waiters per bucket |
| max_429_retries | 3 | n/a | retries on HTTP 429 (honours Retry-After) |
| min_profile_fill_usd | 200 | OMEN_ALCHEMY_MIN_PROFILE_FILL_USD | fills below this skip profiling and funding-graph rebuilds (capped at the lowest signal min_fill_usd) |
| profile_cache_ttl_ms | 43200000 | OMEN_ALCHEMY_PROFILE_CACHE_TTL_MS | wallet and controller profile cache TTL (12h) |

Hot + cold = 280 CU/s, under the 330 CU/s free-tier limit.

## Proxy controller attribution

Polymarket proxy wallets are funded with USDC/USDC.e/pUSD, not POL. The
controller (owner EOA) is read on-chain: `owner()` for beacon-proxy deposit
wallets, Gnosis Safe owner storage for Safes, `isOwner()` checks against the
first inbound funders, and finally a single unique inbound sender. The wallet's
age is then the controller's age.
