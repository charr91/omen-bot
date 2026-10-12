# Alert outcomes and `omen stats` (M1)

While `omen start` runs, the outcome tracker grades signals every `[outcomes] interval_ms` (5 min):

1. **Enroll**: every fill that produced a signal event (last 30 days) gets a `trade_outcomes` row
   (kind `signal`) with its signal ids, highest alert tier, and the fill price as `price_at_alert`.
2. **Baseline**: once the +/-`baseline_window_hours` window has been ingested, up to
   `baseline_per_signal` ordinary fills are sampled per signal fill: same market, within the window,
   0.5-2x the size, a different wallet, never a signal fill, never a likely market maker. Baseline
   rows inherit the signal fill's signal ids and tier, so every group has its own baseline.
3. **Prices**: price at +1h and +24h from CLOB `prices-history` (closest 1-minute point within
   +/-15 min), falling back to the closest ingested fill of the same token within +/-30 min.
   Retries every 30 min for up to 7 days.
4. **Resolution**: hourly Gamma lookup (`closed=true` and open) of each unresolved market; a
   market counts as resolved when it is closed, UMA status is `resolved` (or absent), and one
   outcome price is 1 and the rest 0. Each token's final price (1/0) is stored.
5. **Volume context**: the hour before each signal is compared with a 7-day time-of-day volume
   baseline (ported from insider-poly-bot) and stored as `volume_spike` / `volume_spike_multiplier`.

`omen stats [--days 7] [--json] [--refresh]` prints hit rates per signal and per alert tier for
signal fills and their baseline. A hit is a price move in the trade's direction (BUY up, SELL
down); unchanged prices are left out of `n`. `edge` is the signal hit rate minus the baseline hit
rate. `--refresh` runs one grading pass first.

## Market-maker filter

`[market_maker]` ports insider-poly-bot's heuristic (frequency 30 + buy/sell balance 40 + markets
20 + days active 10, computed from ingested fills up to the fill's time). With `filter_enabled`, a
wallet scoring >= `min_score` (70) gets no live signals (logged as `[mm-filter]`), and such wallets
are excluded from baselines.
