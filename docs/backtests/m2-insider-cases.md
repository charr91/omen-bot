# M2 backtest: omen signals on reported Polymarket insider cases

Generated 2026-10-22T18:13:40.396Z by `omen backtest` (config `omen.config.toml`). Offline replay: no DB, Redis, Telegram, feed or Alchemy.

## Headline

- Insider cases: **9/19 hit** (a delivered MEDIUM+ alert from a deliverable signal on the winning side before the news).
- Median lead time of the first such alert: **38.7 h**.
- False-positive rate on controls: **5/19 (26%)** of control markets had ≥1 delivered MEDIUM+ alert; 0.07 such alerts per control market-day.
- In the insider markets, 12% of delivered MEDIUM+ alerts were on the losing side.

## Per delivered signal

A signal's own alert is delivered when it passes the dedup, the fill's deliverable score is MEDIUM+ and the signal is neither score-only nor shadow. Hit = such an alert on the winning side before the news; FP = a control market with one.

| Signal | Insider hits | Median lead (first hit) | Insider alerts (winning / losing) | Controls with alert (FP) | Control alerts / market-day |
|---|---|---|---|---|---|
| FRESH_WALLET_LARGE_POSITION | 4/19 | 50.0 h | 8 / 2 | 4/19 | 0.05 |
| CONVICTION_SIZE_MISMATCH | 3/19 | 10.2 h | 3 / 0 | 0/19 | 0.00 |
| FRESH_WALLET_LONGSHOT | 5/19 | 21.9 h | 15 / 1 | 1/19 | 0.01 |
| **any delivered** | **9/19** | 38.7 h | — | **5/19** | 0.07 |

## Method

- **Data.** Polymarket data-api `/trades` (taker side, the feed omen ingests live) for each market from `windowStart − 24h` to the news cut-off, paged backwards by `end`; gamma `/markets` for metadata; data-api `/activity` (≤ 500 rows per page) for each wallet with a fill ≥ $250 (the lowest offline signal minimum). All responses cached under `.backtest-cache/`; reruns with `--offline` make no requests. No Alchemy calls, no Postgres/Redis, nothing sent to Telegram or the feed.
- **Replay.** Each candidate fill goes through the live path: `evaluateLiveSignals` (including the sports/weather market exclusion on Gamma metadata) → market-maker filter (`calculateMarketMakerScore` ≥ `market_maker.min_score`) → `computeDeliverableLiveScore` (score-only signals count, shadow signals do not) → `deriveAlertTier` → 24 h per wallet+market dedup (re-alert on +`dedup_score_increase`). Thresholds come from `omen.config.toml` as committed.
- **Point-in-time inputs.** Market 24 h volume = the tape over the 24 h before each fill (gamma `volume24hr` has no history). Wallet totals, fill count, markets and market-maker score come from the wallet's Polymarket activity strictly before the fill. Wallet age = time since its first Polymarket activity (stand-in for the Alchemy first-transfer age; funding usually precedes the first trade by minutes to hours, so this reads slightly *fresher* than live). When the activity pages cannot see a fill's full prior history the wallet gets omen's conservative profile (fresh-wallet, lump and conviction cannot fire), as live does on a degraded profile. Wallets beyond `--max-wallets` per case (largest fills first) also get the conservative profile.
- **Not evaluated.** `SYBIL_CLUSTER` (needs Alchemy funding graphs; muted on Telegram anyway) is off in the replay, so cluster-style cases (Iran Feb 28, ceasefire Apr 7) are scored without it.
- **Scoring.** Live delivery is per (fill, signal): a signal's own alert reaches Telegram when it is deliverable (not score-only, not shadow) and the fill's deliverable tier is MEDIUM+ (the feed sends MEDIUM+; LOW is dry-run). Hit = such an alert on the side that won, before the news cut-off. Lead = news − first such alert. FP = control market with ≥ 1 such alert. The tier columns count every dedup-passing alert, delivered or not.
- **Cut-offs.** News times are the first public signal from the linked reporting (UTC), rounded; see each case. Controls use a same-length window before expiry.

## Per case

| Case | Kind | Window trades / volume | Hit | Best winning-side tier | Lead (first hit) | Lead (first any alert) | Delivered alerts by tier (C/H/M/L) | Signals fired | Reported wallet flagged |
|---|---|---|---|---|---|---|---|---|---|
| nobel-machado-2025 | insider | 3,093 / $983,839 | **HIT** | HIGH | 10.2 h | 10.2 h | 0/1/0/5 | OUTSIZED_POSITION×6, NICHE_MARKET_ENTRY×3, CONVICTION_SIZE_MISMATCH×1, FRESH_WALLET_LARGE_POSITION×1, LUMP_ENTRY×5 | n/a |
| openai-browser-oct31 | insider | 6,457 / $1,527,679 | **HIT** | MEDIUM | 38.7 h | 82.2 h | 0/1/3/13 | OUTSIZED_POSITION×10, NICHE_MARKET_ENTRY×4, LUMP_ENTRY×15, FRESH_WALLET_LARGE_POSITION×3, CONVICTION_SIZE_MISMATCH×7, FRESH_WALLET_LONGSHOT×1 | n/a |
| d4vd-year-in-search | insider | 4,044 / $1,815,360 | miss | LOW | — | 14.9 h | 0/0/0/4 | LUMP_ENTRY×4, CONVICTION_SIZE_MISMATCH×3, OUTSIZED_POSITION×1 | not found in tape |
| maduro-out-jan31 | insider | 1,818 / $612,323 | **HIT** | MEDIUM | 8.3 h | 87.1 h | 0/0/2/5 | LUMP_ENTRY×5, CONVICTION_SIZE_MISMATCH×4, OUTSIZED_POSITION×4, FRESH_WALLET_LONGSHOT×2 | no |
| us-strikes-iran-feb28 | insider | 23,778 / $10,490,941 | **HIT** | HIGH | 56.8 h | 57.8 h | 0/1/8/33 | LUMP_ENTRY×35, CONVICTION_SIZE_MISMATCH×33, FRESH_WALLET_LONGSHOT×9, OUTSIZED_POSITION×1 | no |
| us-iran-ceasefire-apr7 | insider | 18,651 / $5,625,905 | **HIT** | MEDIUM | 16.6 h | 42.3 h | 0/0/2/4 | LUMP_ENTRY×4, CONVICTION_SIZE_MISMATCH×4, FRESH_WALLET_LONGSHOT×2 | n/a |
| us-action-iran-jun21 | insider | 2,245 / $904,453 | **HIT** | MEDIUM | 21.9 h | 37.4 h | 0/0/2/5 | OUTSIZED_POSITION×3, NICHE_MARKET_ENTRY×2, FRESH_WALLET_LARGE_POSITION×1, LUMP_ENTRY×5, FRESH_WALLET_LONGSHOT×1, CONVICTION_SIZE_MISMATCH×4 | n/a |
| us-forces-venezuela-jan31 | insider | 91 / $11,652 | miss | CLEAN | — | — | 0/0/0/0 | — | no |
| khamenei-out-mar31 | insider | 2,814 / $721,857 | miss | LOW | — | 39.2 h | 0/0/0/2 | OUTSIZED_POSITION×2, LUMP_ENTRY×2, CONVICTION_SIZE_MISMATCH×1 | not found in tape |
| israel-strikes-iran-jun13 | insider | 3,164 / $871,563 | **HIT** | HIGH | 59.2 h | 59.2 h | 0/1/0/4 | OUTSIZED_POSITION×3, LUMP_ENTRY×5, CONVICTION_SIZE_MISMATCH×3, FRESH_WALLET_LONGSHOT×1 | n/a |
| israel-iran-ceasefire-jun23 | insider | 503 / $68,463 | miss | CLEAN | — | — | 0/0/0/0 | — | n/a |
| biden-pardon-hunter | insider | 1,420 / $55,151 | miss | CLEAN | — | — | 0/0/0/0 | — | n/a |
| biden-pardon-jim | insider | 2,144 / $532,978 | miss | CLEAN | — | — | 0/0/0/0 | — | n/a |
| biden-pardon-cheney | insider | 1,136 / $161,621 | miss | CLEAN | — | — | 0/0/0/0 | — | n/a |
| biden-pardon-schiff | insider | 443 / $43,500 | miss | CLEAN | — | — | 0/0/0/0 | — | n/a |
| gemini-3-nov18 | insider | 2,553 / $355,979 | **HIT** | MEDIUM | 61.3 h | 61.3 h | 0/0/4/4 | OUTSIZED_POSITION×4, NICHE_MARKET_ENTRY×5, FRESH_WALLET_LARGE_POSITION×4, LUMP_ENTRY×3, CONVICTION_SIZE_MISMATCH×4 | not found in tape |
| pope-leo-not-top-search | insider | 5,615 / $2,439,556 | **HIT** | MEDIUM | 171.8 h | 171.8 h | 0/0/1/3 | OUTSIZED_POSITION×4, NICHE_MARKET_ENTRY×2, FRESH_WALLET_LARGE_POSITION×1, LUMP_ENTRY×3 | not found in tape |
| warsh-fed-chair | insider | 14,582 / $1,339,952 | miss | LOW | — | 213.2 h | 0/0/0/4 | OUTSIZED_POSITION×4, LUMP_ENTRY×4 | no |
| swift-kelce-engaged-2025 | insider | 39 / $1,683 | miss | CLEAN | — | — | 0/0/0/0 | — | no |
| ctl-maduro-out-2025 | control | 3,860 / $2,047,555 | clean | CLEAN | — | 20.5 h | 0/0/0/1 | LUMP_ENTRY×1, CONVICTION_SIZE_MISMATCH×1 | n/a |
| ctl-maduro-out-nov30 | control | 2,185 / $1,141,877 | clean | LOW | — | 90.7 h | 0/0/0/1 | OUTSIZED_POSITION×1, NICHE_MARKET_ENTRY×1, LUMP_ENTRY×1 | n/a |
| ctl-openai-browser-sep30 | control | 320 / $48,610 | clean | CLEAN | — | — | 0/0/0/0 | — | n/a |
| ctl-trump-nobel-2025 | control | 4,825 / $1,998,820 | FP | CLEAN | — | 67.5 h | 0/0/1/9 | LUMP_ENTRY×9, CONVICTION_SIZE_MISMATCH×9, FRESH_WALLET_LONGSHOT×1 | n/a |
| ctl-us-strikes-iran-jan31 | control | 15,375 / $5,503,079 | clean | CLEAN | — | 92.7 h | 0/0/0/20 | LUMP_ENTRY×20, CONVICTION_SIZE_MISMATCH×19, OUTSIZED_POSITION×1 | n/a |
| ctl-us-iran-ceasefire-mar31 | control | 2,724 / $1,888,022 | clean | CLEAN | — | 22.7 h | 0/0/0/2 | OUTSIZED_POSITION×2, LUMP_ENTRY×2 | n/a |
| ctl-us-forces-venezuela-dec31 | control | 347 / $65,588 | clean | CLEAN | — | — | 0/0/0/0 | — | n/a |
| ctl-khamenei-out-2025 | control | 968 / $100,697 | FP | MEDIUM | 5.7 h | 5.7 h | 0/0/1/1 | OUTSIZED_POSITION×2, NICHE_MARKET_ENTRY×2, LUMP_ENTRY×2, FRESH_WALLET_LARGE_POSITION×1 | n/a |
| ctl-israel-strikes-iran-sep30 | control | 463 / $97,907 | FP | MEDIUM | 49.1 h | 49.1 h | 0/0/1/0 | OUTSIZED_POSITION×1, NICHE_MARKET_ENTRY×1, LUMP_ENTRY×1, FRESH_WALLET_LARGE_POSITION×1 | n/a |
| ctl-us-iran-deal-apr30 | control | 522 / $78,133 | clean | CLEAN | — | 68.9 h | 0/0/0/2 | OUTSIZED_POSITION×2, NICHE_MARKET_ENTRY×2, LUMP_ENTRY×2 | n/a |
| ctl-biden-pardon-hillary | control | 450 / $110,321 | clean | CLEAN | — | — | 0/0/0/0 | — | n/a |
| ctl-biden-pardon-sbf | control | 1,063 / $959,551 | clean | LOW | — | 23.2 h | 0/0/0/2 | OUTSIZED_POSITION×2, LUMP_ENTRY×2 | n/a |
| ctl-trump-pardon-hunter | control | 205 / $7,524 | clean | CLEAN | — | — | 0/0/0/0 | — | n/a |
| ctl-gemini-3-by-nov15 | control | 1,695 / $574,778 | FP | MEDIUM | 65.3 h | 65.3 h | 0/0/1/0 | OUTSIZED_POSITION×1, NICHE_MARKET_ENTRY×1, FRESH_WALLET_LARGE_POSITION×1 | n/a |
| ctl-hassett-fed-chair | control | 12,978 / $934,739 | clean | CLEAN | — | 164.3 h | 0/0/0/2 | OUTSIZED_POSITION×1, LUMP_ENTRY×2, CONVICTION_SIZE_MISMATCH×1 | n/a |
| ctl-swift-kelce-before-april | control | 115 / $1,461 | clean | CLEAN | — | — | 0/0/0/0 | — | n/a |
| ctl-spotify-weeknd-2nd | control | 536 / $17,462 | clean | CLEAN | — | — | 0/0/0/0 | — | n/a |
| ctl-navalnaya-nobel-2025 | control | 1,332 / $102,892 | FP | MEDIUM | 11.4 h | 27.0 h | 0/0/1/1 | LUMP_ENTRY×2, CONVICTION_SIZE_MISMATCH×1, OUTSIZED_POSITION×1, NICHE_MARKET_ENTRY×1, FRESH_WALLET_LARGE_POSITION×1 | n/a |
| ctl-openai-hardware-2025 | control | 3 / $2 | clean | CLEAN | — | — | 0/0/0/0 | — | n/a |

### What-if (not shipped): FRESH_WALLET without the niche gate (detection.market.niche_max_volume = ∞)

Hits **9/19**, median lead 38.7 h, controls with a MEDIUM+ alert **7/19** (0.14/market-day), losing-side share in insider markets 24%.

| Case | Hit | Best winning-side tier | Lead (first hit) | Delivered MEDIUM+ (winning / losing) |
|---|---|---|---|---|
| nobel-machado-2025 | **HIT** | HIGH | 10.2 h | 3 / 0 |
| openai-browser-oct31 | **HIT** | MEDIUM | 38.7 h | 9 / 4 |
| d4vd-year-in-search | miss | LOW | — | 0 / 0 |
| maduro-out-jan31 | **HIT** | CRITICAL | 8.3 h | 2 / 0 |
| us-strikes-iran-feb28 | **HIT** | HIGH | 56.8 h | 9 / 1 |
| us-iran-ceasefire-apr7 | **HIT** | MEDIUM | 16.6 h | 2 / 0 |
| us-action-iran-jun21 | **HIT** | CRITICAL | 21.9 h | 1 / 2 |
| us-forces-venezuela-jan31 | miss | CLEAN | — | 0 / 0 |
| khamenei-out-mar31 | miss | LOW | — | 0 / 0 |
| israel-strikes-iran-jun13 | **HIT** | CRITICAL | 59.2 h | 4 / 1 |
| israel-iran-ceasefire-jun23 | miss | CLEAN | — | 0 / 0 |
| biden-pardon-hunter | miss | CLEAN | — | 0 / 0 |
| biden-pardon-jim | miss | CLEAN | — | 0 / 0 |
| biden-pardon-cheney | miss | CLEAN | — | 0 / 0 |
| biden-pardon-schiff | miss | CLEAN | — | 0 / 0 |
| gemini-3-nov18 | **HIT** | MEDIUM | 61.3 h | 4 / 0 |
| pope-leo-not-top-search | **HIT** | MEDIUM | 171.8 h | 1 / 3 |
| warsh-fed-chair | miss | LOW | — | 0 / 0 |
| swift-kelce-engaged-2025 | miss | CLEAN | — | 0 / 0 |
| ctl-maduro-out-2025 | clean | CLEAN | — | 0 / 0 |
| ctl-maduro-out-nov30 | clean | LOW | — | 0 / 0 |
| ctl-openai-browser-sep30 | clean | CLEAN | — | 0 / 0 |
| ctl-trump-nobel-2025 | FP | MEDIUM | 19.6 h | 1 / 1 |
| ctl-us-strikes-iran-jan31 | FP | MEDIUM | 73.2 h | 2 / 0 |
| ctl-us-iran-ceasefire-mar31 | clean | CLEAN | — | 0 / 0 |
| ctl-us-forces-venezuela-dec31 | clean | CLEAN | — | 0 / 0 |
| ctl-khamenei-out-2025 | FP | MEDIUM | 5.7 h | 1 / 0 |
| ctl-israel-strikes-iran-sep30 | FP | MEDIUM | 49.1 h | 1 / 0 |
| ctl-us-iran-deal-apr30 | clean | CLEAN | — | 0 / 0 |
| ctl-biden-pardon-hillary | clean | CLEAN | — | 0 / 0 |
| ctl-biden-pardon-sbf | FP | MEDIUM | 30.7 h | 2 / 0 |
| ctl-trump-pardon-hunter | clean | CLEAN | — | 0 / 0 |
| ctl-gemini-3-by-nov15 | FP | MEDIUM | 65.3 h | 1 / 0 |
| ctl-hassett-fed-chair | clean | CLEAN | — | 0 / 0 |
| ctl-swift-kelce-before-april | clean | CLEAN | — | 0 / 0 |
| ctl-spotify-weeknd-2nd | clean | CLEAN | — | 0 / 0 |
| ctl-navalnaya-nobel-2025 | FP | MEDIUM | 11.4 h | 1 / 0 |
| ctl-openai-hardware-2025 | clean | CLEAN | — | 0 / 0 |

## Average price move vs the same-market, same-band baseline

Same frame as `omen stats` (M1 outcomes): directional move of the traded token (BUY gains when it rises) in cents at +1 h, +24 h and resolution; flat moves are left out of n and the averages. Baseline = candidate fills (≥ the lowest signal minimum) with no signal and no market-maker wallet, **in the same market and the same 20¢ effective entry-price band**, weighted by the signal's fills per (market, band) cell (21,298 baseline fills). Prices come from the public tape (last trade at or before the horizon; resolution price once the market closed), not CLOB mid history as live. "fired" = every firing of the signal at any tier (what live grades); "delivered" = its delivered MEDIUM+ alerts.

| Signal | Scope | Cases | n (+1h / +24h / res) | +1h signal / base / edge | +24h signal / base / edge | Resolution signal / base / edge | Hit rate +24h (signal / base) |
|---|---|---|---|---|---|---|---|
| FRESH_WALLET_LARGE_POSITION | fired | all | 14 / 15 / 15 | +1.6¢ / +0.6¢ / **+1.0¢** | +8.5¢ / -2.5¢ / **+11.0¢** | +17.5¢ / +5.7¢ / **+11.8¢** | 73% / 49% |
| FRESH_WALLET_LARGE_POSITION | fired | insider | 10 / 11 / 11 | +2.3¢ / +0.8¢ / **+1.6¢** | +10.3¢ / -4.2¢ / **+14.5¢** | +22.4¢ / +6.8¢ / **+15.6¢** | 64% / 36% |
| FRESH_WALLET_LARGE_POSITION | fired | control | 4 / 4 / 4 | -0.3¢ / +0.1¢ / **-0.4¢** | +3.4¢ / +1.9¢ / **+1.5¢** | +4.0¢ / +2.8¢ / **+1.2¢** | 100% / 85% |
| FRESH_WALLET_LARGE_POSITION | delivered | all | 13 / 14 / 14 | +2.0¢ / +0.7¢ / **+1.3¢** | +9.0¢ / -2.8¢ / **+11.8¢** | +17.0¢ / +4.4¢ / **+12.6¢** | 71% / 49% |
| FRESH_WALLET_LARGE_POSITION | delivered | insider | 9 / 10 / 10 | +3.0¢ / +0.9¢ / **+2.1¢** | +11.2¢ / -4.7¢ / **+15.9¢** | +22.2¢ / +5.1¢ / **+17.2¢** | 60% / 35% |
| FRESH_WALLET_LARGE_POSITION | delivered | control | 4 / 4 / 4 | -0.3¢ / +0.1¢ / **-0.4¢** | +3.4¢ / +1.9¢ / **+1.5¢** | +4.0¢ / +2.8¢ / **+1.2¢** | 100% / 85% |
| CONVICTION_SIZE_MISMATCH | fired | all | 197 / 205 / 206 | +3.2¢ / +1.4¢ / **+1.8¢** | +31.8¢ / +24.9¢ / **+6.9¢** | +39.5¢ / +37.8¢ / **+1.7¢** | 55% / 50% |
| CONVICTION_SIZE_MISMATCH | fired | insider | 132 / 135 / 135 | +5.2¢ / +2.4¢ / **+2.8¢** | +50.2¢ / +39.6¢ / **+10.5¢** | +64.5¢ / +61.5¢ / **+3.0¢** | 75% / 68% |
| CONVICTION_SIZE_MISMATCH | fired | control | 65 / 70 / 71 | -0.9¢ / -0.5¢ / **-0.4¢** | -3.7¢ / -3.7¢ / **+0.0¢** | -8.2¢ / -7.3¢ / **-0.9¢** | 16% / 16% |
| CONVICTION_SIZE_MISMATCH | delivered | all | 3 / 3 / 3 | +14.7¢ / +7.9¢ / **+6.8¢** | +57.5¢ / +45.0¢ / **+12.6¢** | +81.8¢ / +83.6¢ / **-1.7¢** | 67% / 92% |
| CONVICTION_SIZE_MISMATCH | delivered | insider | 3 / 3 / 3 | +14.7¢ / +7.9¢ / **+6.8¢** | +57.5¢ / +45.0¢ / **+12.6¢** | +81.8¢ / +83.6¢ / **-1.7¢** | 67% / 92% |
| CONVICTION_SIZE_MISMATCH | delivered | control | 0 / 0 / 0 | — / — / **—** | — / — / **—** | — / — / **—** | — / — |
| FRESH_WALLET_LONGSHOT | fired | all | 20 / 21 / 21 | +6.2¢ / +0.3¢ / **+5.9¢** | +48.7¢ / +40.7¢ / **+7.9¢** | +76.6¢ / +67.5¢ / **+9.2¢** | 76% / 71% |
| FRESH_WALLET_LONGSHOT | fired | insider | 19 / 20 / 20 | +6.8¢ / +0.3¢ / **+6.4¢** | +51.3¢ / +42.9¢ / **+8.4¢** | +80.7¢ / +71.1¢ / **+9.6¢** | 80% / 74% |
| FRESH_WALLET_LONGSHOT | fired | control | 1 / 1 / 1 | -4.1¢ / -0.5¢ / **-3.6¢** | -4.2¢ / -3.1¢ / **-1.1¢** | -4.2¢ / -4.4¢ / **+0.1¢** | 0% / 11% |
| FRESH_WALLET_LONGSHOT | delivered | all | 16 / 17 / 17 | +7.9¢ / +0.1¢ / **+7.8¢** | +59.0¢ / +37.8¢ / **+21.2¢** | +73.5¢ / +63.2¢ / **+10.3¢** | 76% / 68% |
| FRESH_WALLET_LONGSHOT | delivered | insider | 15 / 16 / 16 | +8.7¢ / +0.1¢ / **+8.5¢** | +63.0¢ / +40.4¢ / **+22.6¢** | +78.3¢ / +67.4¢ / **+11.0¢** | 81% / 71% |
| FRESH_WALLET_LONGSHOT | delivered | control | 1 / 1 / 1 | -4.1¢ / -0.5¢ / **-3.6¢** | -4.2¢ / -3.1¢ / **-1.1¢** | -4.2¢ / -4.4¢ / **+0.1¢** | 0% / 11% |
| NICHE_MARKET_ENTRY | fired | all | 389 / 436 / 448 | -1.0¢ / -0.5¢ / **-0.5¢** | -3.7¢ / -5.2¢ / **+1.5¢** | -10.8¢ / -9.1¢ / **-1.8¢** | 47% / 48% |
| OUTSIZED_POSITION | fired | all | 747 / 831 / 847 | -0.5¢ / -1.6¢ / **+1.1¢** | -4.6¢ / -6.5¢ / **+1.9¢** | -9.7¢ / -10.2¢ / **+0.5¢** | 49% / 51% |
| LUMP_ENTRY | fired | all | 357 / 386 / 391 | -1.7¢ / -2.3¢ / **+0.6¢** | -5.0¢ / -3.8¢ / **-1.1¢** | -3.5¢ / -5.3¢ / **+1.8¢** | 46% / 47% |

## Case details

### nobel-machado-2025: Will María Corina Machado win the Nobel Peace Prize in 2025?

- Condition `0x14a3dfeba8b22a32feb0f10763db68bc4d2abeb5bff90e9ae20de53793b35a1d`; winner YES.
- Window 2025-10-07T09:00:00Z → news 2025-10-10T09:00:00Z (Oslo announcement 11:00 CEST; bets spiked shortly after midnight Norwegian time).
- 621 candidate fills evaluated; 261 wallets profiled from Polymarket activity.
- Sources: [Guardian, 2025-10-10](https://www.theguardian.com/world/2025/oct/10/nobel-peace-prize-bets-polymarket); [Reuters, 2026-01-30](https://www.reuters.com/world/americas/nobel-committee-says-peace-prize-winner-likely-revealed-early-by-digital-spying-2026-01-30/)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-10-09 22:46 | 6741 | YES ✓ @ 0.100 | $1,500 | $5,794 | 0.1 h | 63 / HIGH | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, CONVICTION_SIZE_MISMATCH, FRESH_WALLET_LARGE_POSITION |
| 2025-10-09 23:27 | Chilyn | NO @ 0.400 | $3,871 | $55,328 | 1267.7 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |
| 2025-10-09 23:56 | Riskmaximized | YES ✓ @ 0.772 | $10,000 | $82,423 | 680.5 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |
| 2025-10-10 01:19 | striketheboats | YES ✓ @ 0.598 | $9,514 | $211,682 | 0.1 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2025-10-10 01:33 | aenews0 | YES ✓ @ 0.652 | $7,954 | $241,020 | 0.0 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### openai-browser-oct31: OpenAI browser by October 31?

- Condition `0xc25e15f39f776813870ee363ed483451add1c55dad163b18bdb2df653be2c90c`; winner YES.
- Window 2025-10-17T00:00:00Z → news 2025-10-21T16:00:00Z (ChatGPT Atlas launch livestream 2025-10-21 10:00 PT (cut-off 1h earlier for the teaser)).
- 1116 candidate fills evaluated; 491 wallets profiled from Polymarket activity.
- Sources: [King & Spalding (new user bet $40k)](https://www.kslaw.com/insights/articles/new-trick-same-crime-insider-trading-on-prediction-markets)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-10-21 15:49 | facetimehi | NO @ 0.069 | $71,614 | $1,233,607 | 8.3 h | 60 / HIGH | OUTSIZED_POSITION, LUMP_ENTRY, FRESH_WALLET_LONGSHOT |
| 2025-10-20 01:19 | darda412 | YES ✓ @ 0.408 | $1,326 | $25,965 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-10-20 02:38 | 0x79475AcbB782588D9dffC91f2819Eb6b67d7eb3d-1759866677948 | YES ✓ @ 0.396 | $1,499 | $31,616 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-10-20 09:35 | 0x8245E70DCF5C2bD5125d0c3a45D3568E28C94F87-1760736824219 | NO @ 0.359 | $1,712 | $85,147 | 40.0 h | 45 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-10-18 05:48 | ughiuyfgiuuy | YES ✓ @ 0.418 | $1,977 | $20,121 | 6493.3 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |

### d4vd-year-in-search: Will d4vd be the #1 searched person on Google this year?

- Condition `0xea17b1284d10617a57f910b2ea63bdef481b1724a4b899d454ff104bea67b657`; winner YES.
- Window 2025-11-26T00:00:00Z → news 2025-12-04T08:00:00Z (Year in Search 2025 published 2025-12-04 (cut-off 00:00 PT); AlphaRaccoon entered 2025-11-27).
- 1138 candidate fills evaluated; 404 wallets profiled from Polymarket activity.
- Sources: [Rolling Stone, 2026-05-28](https://www.rollingstone.com/music/music-news/google-staffer-insider-data-win-d4vd-bet-online-1235569669/); [CFTC complaint 26-cv-4419](https://storage.courtlistener.com/recap/gov.uscourts.nysd.664905/gov.uscourts.nysd.664905.1.0.pdf)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-12-03 17:07 | strawberrycliff | YES ✓ @ 0.118 | $670 | $56,051 | 11.7 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-12-04 04:59 | fgrnkj | NO @ 0.060 | $15,598 | $873,649 | ? | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-12-04 06:51 | debankd | NO @ 0.030 | $797 | $1,254,498 | 1.4 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-12-04 03:23 | hh-betting | YES ✓ @ 0.928 | $17,495 | $135,180 | 7134.8 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### maduro-out-jan31: Maduro out by January 31, 2026?

- Condition `0x580adc1327de9bf7c179ef5aaffa3377bb5cb252b7d6390b027172d43fd6f993`; winner YES.
- Window 2025-12-30T00:00:00Z → news 2026-01-03T06:00:00Z (Strikes on Caracas reported ~02:00 local (06:00 UTC); Trump post 09:21 UTC).
- 344 candidate fills evaluated; 197 wallets profiled from Polymarket activity.
- Sources: [CBS News](https://www.cbsnews.com/news/polymarket-maduro-capture-bet-400000/); [NPR, 2026-01-05](https://www.npr.org/2026/01/05/nx-s1-5667232/polymarket-maduro-bet-insider-trading); [Protos](https://protos.com/maduro-polymarket-bet-raises-insider-trading-concerns/)
- Reported wallet fills in window: 7 ($32,538); best tier LOW.

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-01-02 21:44 | 0xa72DB1749e9AC2379D49A3c12708325ED17FeBd4-1766534754187 | YES ✓ @ 0.072 | $5,783 | $141,136 | 0.0 h | 52 / MEDIUM | OUTSIZED_POSITION, FRESH_WALLET_LONGSHOT |
| 2026-01-03 03:42 | SBet365 | YES ✓ @ 0.113 | $10,000 | $126,743 | 0.0 h | 52 / MEDIUM | OUTSIZED_POSITION, FRESH_WALLET_LONGSHOT |
| 2026-01-01 23:57 | 0x31a56e9E61eD21De08Cbe9524Cdb8eD9-0765984 | YES ✓ @ 0.068 | $5,000 | $165,117 | 138.9 h | 34 / LOW | OUTSIZED_POSITION, LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-12-30 14:52 | 154x838hjd6 | YES ✓ @ 0.074 | $1,390 | $148,984 | 11.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-12-31 00:20 | 0x31a56e9E61eD21De08Cbe9524Cdb8eD9-0765984 | YES ✓ @ 0.090 | $1,238 | $140,155 | 91.2 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### us-strikes-iran-feb28: US strikes Iran by February 28, 2026?

- Condition `0x3488f31e6449f9803f99a8b5dd232c7ad883637f1c86e6953305a2ef19c77f20`; winner YES.
- Window 2026-02-25T06:30:00Z → news 2026-02-28T06:30:00Z (First strike reports ~06:30 UTC (CENTCOM 06:35 UTC)).
- 5488 candidate fills evaluated; 2413 wallets profiled from Polymarket activity.
- Sources: [Forbes, 2026-03-02](https://www.forbes.com/sites/boazsobrado/2026/03/02/fresh-wallets-made-12m-on-polymarket-hours-before-iran-airstrikes/); [CoinDesk, 2026-02-28](https://www.coindesk.com/markets/2026/02/28/suspected-insiders-make-over-usd1-2-million-on-polymarket-ahead-of-u-s-strike-on-iran)
- Reported wallet fills in window: 8 ($11,853); best tier CLEAN.

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-02-28 03:05 | 0x5fF872Bf119684F4F5fB1Ad46D55d8f4C62d54ad-1773595841462 | YES ✓ @ 0.170 | $9,300 | $4,701,078 | 3.2 h | 62 / HIGH | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH, FRESH_WALLET_LONGSHOT |
| 2026-02-27 22:52 | 0x274C45994BfA0912cf8bEe503190952E6Af7DA86-1772189577856 | YES ✓ @ 0.197 | $15,000 | $4,278,923 | 11.9 h | 48 / MEDIUM | LUMP_ENTRY, FRESH_WALLET_LONGSHOT |
| 2026-02-25 21:40 | 0x1caA6a7ad0c6916aeF7b67946De2e57Ad24846a0-1772054568088 | YES ✓ @ 0.100 | $7,198 | $1,502,075 | 0.0 h | 40 / MEDIUM | FRESH_WALLET_LONGSHOT |
| 2026-02-26 22:53 | Neodbs | YES ✓ @ 0.100 | $9,884 | $1,970,886 | 0.0 h | 40 / MEDIUM | FRESH_WALLET_LONGSHOT |
| 2026-02-27 22:43 | 0x3811e09b | YES ✓ @ 0.180 | $10,000 | $4,244,061 | 0.0 h | 40 / MEDIUM | FRESH_WALLET_LONGSHOT |

### us-iran-ceasefire-apr7: US x Iran ceasefire by April 7?

- Condition `0x4c5701bcde0b8fb7d7f48c8e9d20245a6caa58c61a77f981fad98f2bfa0b1bc7`; winner YES.
- Window 2026-04-05T22:30:00Z → news 2026-04-07T22:30:00Z (Trump Truth Social post ~18:30 ET).
- 4549 candidate fills evaluated; 1745 wallets profiled from Polymarket activity.
- Sources: [AP News](https://apnews.com/article/polymarket-iran-trump-ceasefire-prediction-markets-350d9fe5ffefa74080ff5dd973aef48b); [Reuters factbox, 2026-04-08](https://www.reuters.com/sustainability/boards-policy-regulation/some-trades-ahead-trump-policy-moves-raise-questions-2026-04-08/)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-04-07 05:56 | antrouklasxaxa | YES ✓ @ 0.040 | $5,000 | $1,686,407 | 0.0 h | 40 / MEDIUM | FRESH_WALLET_LONGSHOT |
| 2026-04-07 10:01 | Friidjdncoriejwnsnndmvtkoeiein4848588382 | YES ✓ @ 0.059 | $10,000 | $1,549,485 | 0.0 h | 40 / MEDIUM | FRESH_WALLET_LONGSHOT |
| 2026-04-06 04:10 | pronigga | YES ✓ @ 0.056 | $3,000 | $1,108,751 | 13736.7 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-04-06 21:07 | 0x755519c3A4a69469F488197fBD39B12f70B3EcC5-1775507911807 | YES ✓ @ 0.032 | $1,467 | $1,733,449 | 0.3 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-04-07 14:06 | The-insider-formerly-known-as-25xp | YES ✓ @ 0.043 | $4,168 | $1,517,228 | 0.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### us-action-iran-jun21: US military action against Iran by Saturday? (2025-06-21)

- Condition `0x6c6cff89b135f5684f5a25a98fd0335814d1bc411d08bfcf0be400db76ce511a`; winner YES.
- Window 2025-06-18T23:50:00Z → news 2025-06-21T23:50:00Z (Trump announced the Fordow/Natanz strikes ~19:50 ET).
- 851 candidate fills evaluated; 357 wallets profiled from Polymarket activity.
- Sources: [ACDC, Insider Risks in Polymarket Political Markets (Apr 2026)](https://acdatacollective.org/wp-content/uploads/2026/04/Insider_Risks_in_Polymarket_Political_Markets_ACDC.pdf)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-06-21 01:55 | anas10 | YES ✓ @ 0.201 | $7,000 | $109,922 | 0.0 h | 52 / MEDIUM | OUTSIZED_POSITION, FRESH_WALLET_LONGSHOT |
| 2025-06-20 10:25 | Lupaed67 | NO @ 0.940 | $1,156 | $19,700 | 22.2 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-06-20 13:38 | xiri | NO @ 0.920 | $1,200 | $36,248 | 4059.4 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |
| 2025-06-21 06:24 | B2twarminius | YES ✓ @ 0.070 | $609 | $174,905 | 0.2 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-06-21 14:34 | Lol123555 | YES ✓ @ 0.124 | $5,805 | $303,859 | 214.3 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### us-forces-venezuela-jan31: US forces in Venezuela by January 31, 2026?

- Condition `0xbb8bfdef9052b2709557a6f8f28b23551e3134bfb86eca800211e2191703ee65`; winner YES.
- Window 2025-12-30T00:00:00Z → news 2026-01-03T06:00:00Z (Same operation as Maduro Jan 31; complaint: Van Dyke also held YES here until it resolved).
- 20 candidate fills evaluated; 16 wallets profiled from Polymarket activity.
- Sources: [CFTC complaint vs Van Dyke, 2026-04-23](https://www.cftc.gov/media/13761/EnfGannonKenVanDykeComplaint042326/download); [CFTC release 9217-26](https://www.cftc.gov/PressRoom/PressReleases/9217-26)
- Reported wallet fills in window: 1 ($50); best tier CLEAN.

### khamenei-out-mar31: Khamenei out as Supreme Leader of Iran by March 31?

- Condition `0x70909f0ba8256a89c301da58812ae47203df54957a07c7f8b10235e877ad63c2`; winner YES.
- Window 2026-02-25T06:30:00Z → news 2026-02-28T06:30:00Z (Cut-off = first strike reports (06:30 UTC), before his death was known; Magamyman bought before the strikes).
- 378 candidate fills evaluated; 230 wallets profiled from Polymarket activity.
- Sources: [NPR, 2026-03-01](https://www.npr.org/2026/03/01/nx-s1-5731568/polymarket-trade-iran-supreme-leader-killing); [USA Today, 2026-03-03](https://www.usatoday.com/story/money/2026/03/03/magamyman-polymarket-trader-iran-bets/88949233007/)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-02-27 19:54 | 0x4D8a89D16700BEfB5402406CBd5Add446448548c-1767913407872 | YES ✓ @ 0.224 | $6,851 | $311,827 | 1180.9 h | 34 / LOW | OUTSIZED_POSITION, LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-02-26 15:18 | narchiebald | NO @ 0.840 | $5,060 | $160,057 | 64.0 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### israel-strikes-iran-jun13: Israel military action against Iran before July? (2025-06-13)

- Condition `0xd25ff3223a2233f6cd96a349455ca3237931c64358792f90c5f02d8cc39be38d`; winner YES.
- Window 2025-06-10T00:00:00Z → news 2025-06-12T23:30:00Z (Operation Rising Lion began ~03:00 IDT June 13; indictment: an IAF reservist tipped a friend who bet "before July").
- 746 candidate fills evaluated; 306 wallets profiled from Polymarket activity.
- Sources: [Ynet, IAF major indictment](https://www.ynetnews.com/article/sjjp4m7o11l); [Times of Israel, 2026-03-27](https://www.timesofisrael.com/israeli-air-force-major-charged-with-using-classified-info-to-place-bets-on-polymarket/); [Rajiv Sethi, 2025-06-18 (fresh account, $134k)](https://rajivsethi.substack.com/p/betting-on-geopolitical-violence)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-06-10 12:16 | AngCh | YES ✓ @ 0.275 | $5,898 | $136,435 | 0.1 h | 74 / HIGH | OUTSIZED_POSITION, LUMP_ENTRY, CONVICTION_SIZE_MISMATCH, FRESH_WALLET_LONGSHOT |
| 2025-06-10 18:57 | Trendo | YES ✓ @ 0.290 | $2,030 | $129,184 | 0.0 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-06-11 10:12 | runningBTC | YES ✓ @ 0.289 | $1,000 | $149,807 | 444.8 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-06-11 12:51 | 0xc0a005750061E6B5c5699c395A09FD238116aC10-1749642840055 | YES ✓ @ 0.300 | $2,848 | $129,434 | 0.0 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2025-06-11 18:23 | Rundeep | YES ✓ @ 0.658 | $3,000 | $149,395 | 25.3 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### israel-iran-ceasefire-jun23: Israel x Iran ceasefire before July? (2025-06-23)

- Condition `0x3b2f19935f2a969634a7aca52b69cf653d957ec6243bdfcb97dd830003e90624`; winner YES.
- Window 2025-06-20T22:00:00Z → news 2025-06-23T22:00:00Z (Trump Truth Social ~18:00 ET; indictment says the same pair won a bet on the war's end date (market not named, best match)).
- 106 candidate fills evaluated; 64 wallets profiled from Polymarket activity.
- Sources: [Times of Israel, 2026-03-27](https://www.timesofisrael.com/israeli-air-force-major-charged-with-using-classified-info-to-place-bets-on-polymarket/)

### biden-pardon-hunter: Will Joe pardon Hunter Biden?

- Condition `0x0e85e94301db0e38e25f0650ab649c3a4485b5fc9734a8b6abf3d0da0ee6dd55`; winner YES.
- Window 2024-11-28T23:00:00Z → news 2024-12-01T23:00:00Z (Pardon announced Sunday evening Dec 1 (cut-off 18:00 ET); Bubblemaps: same trader as the Jan 20 pardon bets).
- 39 candidate fills evaluated; 33 wallets profiled from Polymarket activity.
- Sources: [NPR, 2026-04-16 (Bubblemaps)](https://www.npr.org/2026/04/16/nx-s1-5786580/a-polymarket-trader-made-300-000-betting-on-bidens-pardons-a-new-analysis-shows); [CNN, 2024-12-01](https://www.cnn.com/2024/12/01/politics/joe-biden-pardon-hunter-biden-statement)

### biden-pardon-jim: Will Biden pardon Jim Biden?

- Condition `0xcde81adc8f07ce43f0287684a259ac4a6b3612a73c71c0247c6bc8b2bc97a691`; winner YES.
- Window 2025-01-17T16:40:00Z → news 2025-01-20T16:40:00Z (Family pardons announced ~11:40 ET Jan 20; reported $21.7k YES at ~11%).
- 351 candidate fills evaluated; 149 wallets profiled from Polymarket activity.
- Sources: [NPR, 2026-04-16 (Bubblemaps)](https://www.npr.org/2026/04/16/nx-s1-5786580/a-polymarket-trader-made-300-000-betting-on-bidens-pardons-a-new-analysis-shows); [Decrypt](https://decrypt.co/364660/suspicious-polymarket-trader-320k-2025-biden-pardons)

### biden-pardon-cheney: Will Biden pardon Liz Cheney?

- Condition `0x0ba6d0a2f35fbb9a38aaee50b4a44b21093f4da96a2c3a3b49704b488a6b6b20`; winner YES.
- Window 2025-01-17T12:30:00Z → news 2025-01-20T12:30:00Z (Jan 6 committee pre-emptive pardons announced ~07:30 ET Jan 20).
- 156 candidate fills evaluated; 81 wallets profiled from Polymarket activity.
- Sources: [NPR, 2026-04-16 (Bubblemaps)](https://www.npr.org/2026/04/16/nx-s1-5786580/a-polymarket-trader-made-300-000-betting-on-bidens-pardons-a-new-analysis-shows); [NBC News, 2025-01-20](https://www.nbcnews.com/politics/joe-biden/biden-issues-preemptive-pardons-milley-fauci-jan-6-panel-members-polic-rcna188368)

### biden-pardon-schiff: Will Biden pardon Adam Schiff?

- Condition `0x072acaa7dd352c795948d495e019eec539539d36698225ab98b2f55c692d1b0c`; winner YES.
- Window 2025-01-17T12:30:00Z → news 2025-01-20T12:30:00Z (Jan 6 committee pardons ~07:30 ET Jan 20; reported entry at ~6%).
- 59 candidate fills evaluated; 43 wallets profiled from Polymarket activity.
- Sources: [Decrypt](https://decrypt.co/364660/suspicious-polymarket-trader-320k-2025-biden-pardons); [The Verge](https://www.theverge.com/policy/913069/someone-made-over-300000-betting-on-biden-pardons)

### gemini-3-nov18: Will Gemini 3.0 be released on November 18 2025?

- Condition `0xcb42ce799c32e8f0bbe7df6a20396a7ecb1ca494316c5df0027ab89d941e1ca7`; winner YES.
- Window 2025-11-14T12:00:00Z → news 2025-11-17T12:00:00Z (Launch 2025-11-18 16:00 UTC; cut-off a day earlier, when Gemini 3 was spotted in AI Studio; AlphaRaccoon won ~$150k here).
- 346 candidate fills evaluated; 187 wallets profiled from Polymarket activity.
- Sources: [Gizmodo](https://gizmodo.com/polymarket-user-accused-of-1-million-insider-trade-on-google-search-markets-2000696258); [Forbes, 2025-12-04](https://www.forbes.com/sites/boazsobrado/2025/12/04/alleged-insider-nets-1-million-on-polymarket-in-24-hours/); [BleepingComputer (AI Studio sighting)](https://www.bleepingcomputer.com/news/google/google-gemini-3-spotted-on-ai-studio-ahead-of-imminent-release/)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-11-14 22:42 | 0xEcE847ea152616dCaf5d65aaD4E73ea1DDc2cAC6-1763158294527 | YES ✓ @ 0.596 | $1,139 | $34,384 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-11-15 03:31 | pitya | YES ✓ @ 0.808 | $2,498 | $72,535 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-11-15 06:11 | WaterDropplet | YES ✓ @ 0.753 | $2,149 | $81,700 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-11-15 06:50 | 7sea | YES ✓ @ 0.798 | $5,801 | $85,079 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-11-15 08:46 | joker3333 | NO @ 0.251 | $981 | $99,279 | 15.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### pope-leo-not-top-search: Will Pope Leo XIV be the #1 searched person on Google this year? (No)

- Condition `0xb9b05c3a14c6a7c1c6c00a8c214ed154d4232a885f98ebfd01889204ed252931`; winner NO.
- Window 2025-11-26T00:00:00Z → news 2025-12-04T08:00:00Z (Year in Search 2025 published Dec 4; listed in the CFTC complaint (AlphaRaccoon, NO side)).
- 902 candidate fills evaluated; 430 wallets profiled from Polymarket activity.
- Sources: [CFTC complaint 26-cv-4419](https://storage.courtlistener.com/recap/gov.uscourts.nysd.664905/gov.uscourts.nysd.664905.1.0.pdf); [Reuters via Investing.com, 2026-05-27](https://www.investing.com/news/stock-market-news/us-charges-google-engineer-with-insider-trading-on-polymarket-4713459)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-11-27 04:09 | bbdree | NO ✓ @ 0.620 | $1,075 | $27,006 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-12-01 20:55 | DicholasJ. | NO ✓ @ 0.470 | $4,996 | $62,660 | 261.1 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |
| 2025-12-02 13:27 | shimpei | YES @ 0.500 | $37,211 | $118,482 | 15.5 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2025-12-03 16:02 | albertbert | YES @ 0.490 | $3,675 | $145,114 | 33.2 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### warsh-fed-chair: Will Trump nominate Kevin Warsh as the next Fed chair?

- Condition `0x61b66d02793b4a68ab0cc25be60d65f517fe18c7d654041281bb130341244fcc`; winner YES.
- Window 2026-01-20T00:00:00Z → news 2026-01-29T14:00:00Z (Reports Jan 29 that Warsh was the pick (cut-off 09:00 ET); Truth Social nomination Jan 30 06:48 ET; quant42 entered ~Jan 21).
- 1320 candidate fills evaluated; 346 wallets profiled from Polymarket activity.
- Sources: [IBTimes UK, 2026-01-30](https://www.ibtimes.co.uk/someone-bet-kevin-warsh-fed-chair-9-days-ago-before-everyone-else-started-paying-attention-1775072); [CNBC, 2026-01-29](https://www.cnbc.com/2026/01/29/trump-says-he-will-announce-a-replacement-for-powell-as-fed-chair-friday-morning.html)
- Reported wallet fills in window: 1 ($1,740); best tier CLEAN.

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-01-20 16:50 | metsW | NO @ 0.400 | $20,000 | $254,671 | 1718.3 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2026-01-20 22:52 | predictor555 | NO @ 0.536 | $17,597 | $301,949 | ? | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2026-01-22 10:40 | 0xc6174a742B2926f00E683828019CEF708ff9cd8E-1762579911011 | YES ✓ @ 0.450 | $5,717 | $247,908 | 243.2 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2026-01-23 18:22 | psa10snorlax | YES ✓ @ 0.423 | $2,926 | $104,217 | 317.3 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### swift-kelce-engaged-2025: Taylor Swift and Travis Kelce engaged in 2025?

- Condition `0x89ac32e18929185f5bd0dc00e70337571f546e64ae5cd16dceb6026ac2679c1e`; winner YES.
- Window 2025-08-23T17:00:00Z → news 2025-08-26T17:00:00Z (Instagram post 13:00 ET Aug 26; romanticpaul bought from ~24 h before, last buy 15 min before).
- 15 candidate fills evaluated; 2 wallets profiled from Polymarket activity.
- Sources: [Business Insider, 2025-08](https://www.businessinsider.com/taylor-swift-travis-kelce-engagement-polymarket-bet-pays-off-2025-8); [Mitts & Ofir, Harvard Law corp-gov forum](https://corpgov.law.harvard.edu/2026/03/25/from-iran-to-taylor-swift-informed-trading-in-prediction-markets/)
- Reported wallet fills in window: 14 ($842); best tier CLEAN.

### ctl-maduro-out-2025: Maduro out in 2025?

- Condition `0xafc235557ace53ff0b0d2e93392314a7c3f3daab26a79050e985c11282f66df7`; winner NO.
- Window 2025-12-28T00:00:00Z → news 2026-01-01T00:00:00Z (Expired No at year end).
- 851 candidate fills evaluated; 506 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/maduro-out-in-2025)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-12-31 03:28 | Rough-Tigerflow | YES @ 0.007 | $706 | $751,359 | 0.2 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### ctl-maduro-out-nov30: Maduro out by November 30, 2025?

- Condition `0xa953bea944d7264285c0a2cc1f92809a7d9db78138b1c3de9cc23d8917f14d6a`; winner NO.
- Window 2025-11-27T00:00:00Z → news 2025-12-01T00:00:00Z (Expired No).
- 613 candidate fills evaluated; 405 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/maduro-out-in-2025)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-11-27 05:16 | tgk7iu7gtiu87 | NO ✓ @ 0.988 | $5,585 | $86,198 | 469.7 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |

### ctl-openai-browser-sep30: OpenAI browser by September 30?

- Condition `0x097be0fa66524b5de5893630d4cb2f44a379e9c2d8b9b1372227e7f46e288b40`; winner NO.
- Window 2025-09-26T00:00:00Z → news 2025-09-30T23:59:00Z (Expired No).
- 47 candidate fills evaluated; 26 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/openai-browser-by-september-30)

### ctl-trump-nobel-2025: Will Donald Trump win the Nobel Peace Prize in 2025?

- Condition `0x200369a7fc4dad910665c5a77e1c0c0d16237f79c637928bf0c5112cac2db708`; winner NO.
- Window 2025-10-07T09:00:00Z → news 2025-10-10T09:00:00Z (Same event and window as the Machado case).
- 1756 candidate fills evaluated; 988 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/nobel-peace-prize-winner-2025)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-10-10 08:25 | 0xc71558be | YES @ 0.042 | $10,395 | $1,460,748 | 0.0 h | 40 / MEDIUM | FRESH_WALLET_LONGSHOT |
| 2025-10-07 13:28 | 0xFEbb4b3d8a3B330ffBE5320FEF63B770d0374016-1759842762347 | YES @ 0.027 | $500 | $212,547 | 0.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-10-08 17:23 | ivan | YES @ 0.028 | $1,000 | $146,175 | 11957.3 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-10-09 10:17 | 0xe1C13e13e5209F2FBe5121F91861BF41c735aE78-1759861090207 | YES @ 0.066 | $501 | $299,688 | 0.6 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-10-09 13:10 | moeks | YES @ 0.067 | $1,238 | $466,965 | 261.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### ctl-us-strikes-iran-jan31: US strikes Iran by January 31, 2026?

- Condition `0xabb86b080e9858dcb3f46954010e49b6f539c20036856c7f999395bfd58d01e6`; winner NO.
- Window 2026-01-28T00:00:00Z → news 2026-01-31T23:59:00Z (Expired No).
- 4438 candidate fills evaluated; 2327 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/us-strikes-iran-by)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-01-28 03:14 | 0x8517b5ee | YES @ 0.100 | $551 | $481,167 | 217.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-01-28 20:14 | AbsoluteDestroyer | YES @ 0.120 | $1,498 | $548,227 | 0.0 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-01-29 00:59 | butteredbiscuit | YES @ 0.110 | $924 | $671,236 | 12837.2 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-01-29 12:57 | Amarmic | YES @ 0.100 | $500 | $748,124 | 0.0 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-01-29 15:34 | 0x4f5D95DFd7573467dF6F8C676e7494386036EA9e-1769371728094 | YES @ 0.150 | $2,000 | $701,636 | 91.0 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### ctl-us-iran-ceasefire-mar31: US x Iran ceasefire by March 31?

- Condition `0x3c6bcb7da14ea576e5af25547dbd96f2bb24ac34e748e76aecff2ee9195dd1ac`; winner NO.
- Window 2026-03-29T23:59:00Z → news 2026-03-31T23:59:00Z (Expired No. Caveat: the Guardian reported ~8 new accounts betting ~$70k YES here around Mar 21 (they lost); kept for comparability).
- 937 candidate fills evaluated; 578 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/us-x-iran-ceasefire-by)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-03-31 01:16 | 0x436f969D99c90191fBC2c629e6B7a1B754402c7F-1772236065502 | YES @ 0.008 | $75,031 | $885,310 | 234.5 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2026-03-31 22:13 | kylez41 | YES @ 0.004 | $24,306 | $919,596 | 442.2 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### ctl-us-forces-venezuela-dec31: US forces in Venezuela by December 31?

- Condition `0x467176b3079c10574bef26546e834f5d3c1551bada9ec1d43ee5814651a0baf9`; winner NO.
- Window 2025-12-28T00:00:00Z → news 2026-01-01T00:00:00Z (Expired No).
- 107 candidate fills evaluated; 57 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/us-forces-in-venezuela-by)

### ctl-khamenei-out-2025: Khamenei out as Supreme Leader of Iran in 2025?

- Condition `0x1b6f76e5b8587ee896c35847e12d11e75290a8c3934c5952e8a9d6e4c6f03cfa`; winner NO.
- Window 2025-12-28T00:00:00Z → news 2026-01-01T00:00:00Z (Expired No).
- 72 candidate fills evaluated; 60 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/khamenei-out-as-supreme-leader-of-iran-in-2025)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-12-31 18:19 | 0x6720987C1e01B1fbF6817F8f4148E878b5670fab-1750038860268 | NO ✓ @ 0.999 | $1,998 | $22,816 | 0.0 h | 57 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-12-31 21:23 | macanga | YES @ 0.004 | $2,432 | $33,379 | 4655.9 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |

### ctl-israel-strikes-iran-sep30: Israel strikes Iran by September 30? (2025)

- Condition `0xa74304523e0d5b3ea3ce9d44a7ec5e67cc2ccf15735d46a186497d23a5d9edde`; winner NO.
- Window 2025-09-27T00:00:00Z → news 2025-10-01T00:00:00Z (Expired No).
- 83 candidate fills evaluated; 54 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/israel-strikes-iran-by-september-30)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-09-28 22:55 | 333blacksea | NO ✓ @ 0.991 | $1,794 | $22,632 | 16.8 h | 57 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY, FRESH_WALLET_LARGE_POSITION |

### ctl-us-iran-deal-apr30: US-Iran nuclear deal by April 30? (2026)

- Condition `0xd08544f6162283dc8d0a82f16362aab837a8537379df9bbe604960eec9cd4618`; winner NO.
- Window 2026-04-27T00:00:00Z → news 2026-05-01T00:00:00Z (Expired No).
- 61 candidate fills evaluated; 49 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/us-iran-nuclear-deal-by-april-30)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-04-28 03:06 | 0xB8eE94bD599A92D4747DdA5f3bc6D2B243349e81-1765943326811 | YES @ 0.011 | $1,978 | $27,694 | ? | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |
| 2026-04-29 14:28 | 0x7d70e264 | YES @ 0.006 | $6,491 | $14,884 | 242.7 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |

### ctl-biden-pardon-hillary: Will Biden pardon Hillary?

- Condition `0x7f697cf4dcabd2440273944aef7a6867471b02f2f462f9703229abd8c2745b22`; winner NO.
- Window 2025-01-17T16:40:00Z → news 2025-01-20T16:40:00Z (Same event and window as the Jim Biden case).
- 105 candidate fills evaluated; 58 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/who-will-biden-pardon)

### ctl-biden-pardon-sbf: Will Biden pardon SBF?

- Condition `0xf4078ddd084c8979c81f1ac4674d5e846b87a13b7f568bdd402296181e83b4d9`; winner NO.
- Window 2025-01-17T16:40:00Z → news 2025-01-20T16:40:00Z (Same event and window as the Jim Biden case).
- 372 candidate fills evaluated; 194 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/who-will-biden-pardon)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-01-19 17:25 | Kickstand7 | NO ✓ @ 0.964 | $56,684 | $223,558 | ? | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2025-01-19 19:45 | NGMA | NO ✓ @ 0.973 | $94,170 | $308,969 | 264.5 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### ctl-trump-pardon-hunter: Will Trump pardon Hunter Biden?

- Condition `0x1c08575bf76817784ff133142eacc37506f1bdeeeb4d3901bed1189b8091ff03`; winner NO.
- Window 2025-04-16T12:00:00Z → news 2025-04-19T12:00:00Z (Expired No).
- 7 candidate fills evaluated; 7 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/will-trump-pardon-hunter-biden)

### ctl-gemini-3-by-nov15: Will Gemini 3.0 be released by November 15?

- Condition `0xca115707c2c17262646adee5b0eb92286d4761ad8ae76cea66f2f2df57e85f5e`; winner NO.
- Window 2025-11-12T12:00:00Z → news 2025-11-16T05:00:00Z (Expired No (end of Nov 15 ET)).
- 446 candidate fills evaluated; 287 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/gemini-3pt0-released-by)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-11-13 11:39 | 9Wangy | NO ✓ @ 0.930 | $1,995 | $76,385 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |

### ctl-hassett-fed-chair: Will Trump nominate Kevin Hassett as the next Fed chair?

- Condition `0xdcc87b9ca36015e396bd0eebca29e854a136ed2b0b701049d1ee9da6bee3eb35`; winner NO.
- Window 2026-01-20T00:00:00Z → news 2026-01-29T14:00:00Z (Same event and window as the Warsh case).
- 1368 candidate fills evaluated; 391 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/who-will-trump-nominate-as-fed-chair)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-01-26 13:50 | OllieJ | YES @ 0.089 | $684 | $93,170 | 2849.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-01-22 17:42 | 0xAB8959231b67c6e91Ae04ef359c7E4A01f3Dc4eF-1768577627032 | YES @ 0.060 | $9,951 | $111,543 | 146.0 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### ctl-swift-kelce-before-april: Taylor Swift and Travis Kelce engaged before April? (2025)

- Condition `0x26af267d671532b83ffb5779f5a62d3ce21590d1220ad5649528063a9599164f`; winner NO.
- Window 2025-03-28T12:00:00Z → news 2025-03-31T12:00:00Z (Expired No).
- 1 candidate fills evaluated; 1 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/taylor-swift-and-travis-kelce-engaged-before-april)

### ctl-spotify-weeknd-2nd: Will The Weeknd be the second most streamed Spotify artist for 2025?

- Condition `0xfd5a7d8cb258c7790a9c385d5999aff844108e66edd600f851a11397ede1c73b`; winner NO.
- Window 2025-11-30T12:00:00Z → news 2025-12-03T12:00:00Z (Spotify Wrapped 2025 (Dec 3; cut-off 07:00 ET); a data-release market like Year in Search, no reported leak).
- 176 candidate fills evaluated; 144 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/2-most-streamed-spotify-artist-2025)

### ctl-navalnaya-nobel-2025: Will Yulia Navalnaya win the Nobel Peace Prize in 2025?

- Condition `0xb1de8e4de72cc5674815e0ac09adce40ba94f3dec50e64ea15918f109fa58339`; winner NO.
- Window 2025-10-07T09:00:00Z → news 2025-10-10T09:00:00Z (Same event and window as the Machado case (a smaller market, like Machado)).
- 175 candidate fills evaluated; 104 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/nobel-peace-prize-winner-2025)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-10-09 21:37 | Neverevergiveup | NO ✓ @ 0.920 | $1,308 | $14,265 | 0.0 h | 57 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-10-09 06:02 | 0x3B242DC4B65136C917E54b27b9b1Be84e3A5Ca45-1759622088659 | YES @ 0.092 | $500 | $4,074 | 0.0 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### ctl-openai-hardware-2025: Will OpenAI launch a new consumer hardware product in 2025?

- Condition `0xd4f79cbb0e6aa3035f19ea539d7186d126b4ba6f9b6aa463ebea7d3523f8bf05`; winner NO.
- Window 2025-12-28T00:00:00Z → news 2026-01-01T00:00:00Z (Expired No).
- 1 candidate fills evaluated; 1 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/will-openai-launch-a-consumer-hardware-product-by)

<!-- findings:start (hand-written; `omen backtest` keeps this block) -->
## Findings (hand-written, 2026-10-22; config after 1eb6110: sports excluded, SYBIL muted, NICHE/OUTSIZED/LUMP score-only, Telegram = FWLP + CSM + FWL)

Case set grown to **19 insider + 19 controls** (no sports). The new insider markets come from public reporting (CFTC complaint, NPR, CNN, Forbes, Gizmodo, Times of Israel, Investing.com/Reuters, IBTimes, CNBC, Business Insider; links in each case). The controls are non-sports markets with no reported leak, mostly siblings or earlier deadlines in the same events. On the 7 + 6 cases from 2026-10-16 the current config scores **6/7 hits, 1/6 control FPs**, which matches the "combined" figure from finding 6 below now that FWL delivers. On the full set: **9/19 hits, median lead 38.7 h, 5/19 controls with a delivered MEDIUM+ alert (0.07 / market-day)**.

1. **FRESH_WALLET_LONGSHOT has the cleanest record.** 5/19 hits, median lead 21.9 h, 15 winning vs 1 losing delivered alerts in insider markets, 1/19 control FP (Trump-Nobel, losing side). Against the same-market, same-band baseline its delivered alerts lead by **+8.5¢ at +1 h** and +22.6¢ at +24 h in insider markets. n = 16 fills in 6 markets, so treat it as directional; case-clustered t < 2.
2. **FRESH_WALLET_LARGE_POSITION finds insiders but carries all 4 of the other control FPs.** 4/19 hits (Nobel, OpenAI browser, Gemini 3, Pope-not-top-search), median lead 50 h, 8 winning / 2 losing alerts. Insider edge is +14.5¢ at +24 h (n = 11). **Every control FP it raised (Khamenei 2025, Israel-strikes Sep 30, Gemini-by-Nov-15, Navalnaya) is a fresh wallet buying the near-certain side at an effective 0.92–1.00.** Those fills cannot move more than a few cents, and their controls edge is +1.5¢ at +24 h (n = 4). That matches the live **+2¢ at 24 h (n = 71)**, which most likely comes from no-leak markets like these. Every winning FWLP alert in an insider market was at an effective 0.10–0.81.
3. **CONVICTION_SIZE_MISMATCH reproduces the live number and little else.** Across all firings (any tier, the frame live grades): n = 205 at +24 h, edge **+1.8¢ at +1 h** and +6.9¢ at +24 h. The +24 h figure comes almost entirely from the two cluster-style Iran markets (Feb 28, Apr 7). Without them it is **+1.2¢ / +1.7¢ (n ≈ 120)**, the same as live **+2¢ / +2¢ (n = 203)**. On controls it is −0.4¢ / 0.0¢. CSM alone (score 14) almost never reaches MEDIUM: only 3 delivered alerts (all winning, insider) and 3/19 hits. Most of its firings are CLEAN or LOW dry-run.
   - **By size:** the edge sits in $250–1k fills. $1k+ fills show none (+1.2¢ at +24 h, n = 49).
   - **By price:** the 10–20¢ bucket is strongest (+12.5¢ at +24 h). Fills under 10¢ show ≈ 0.
   - **By ratio and age:** fill/wallet-volume ratio shows no gradient (0.5–0.8 ≈ 0.95+), and neither does wallet age.
4. **Significance.** No delivered signal clears t = 2 once fills are clustered by market (CSM 24 h: fill-level t = 4.4, case-clustered t = 1.55). The insider markets resolve toward the leak by construction, so the absolute moves there are selection-biased. The same-market, same-band baseline removes most of that bias, and the control rows are the unbiased check.
5. **Still missed.** The four Biden pardon markets, Warsh, Khamenei-Mar-31, Venezuela-Jan-31, the Jun 23 ceasefire and Swift/Kelce stay CLEAN or LOW. They are either thin (under 100 window fills) or the leak was made of sub-$1k bets from older wallets. The niche-gate what-if again adds no hits (9/19) and raises control FPs to 7/19, so keep the gate.

**Recommended threshold tweaks (not shipped):**

- **FWLP: add an effective-price cap of 0.90** (new knob, e.g. `detection.market.large_position_max_price = 0.90`). On this data the cap would remove all 4 FWLP control FPs (any-delivered FP 5/19 → 1/19). It keeps all 4 FWLP hits and every winning alert, and drops one losing insider alert (Iran Jun 21 at 0.94). The rule is fit on 4 control fills, so before shipping, check live FWLP outcomes in the 80–100¢ entry band (`omen stats`). Keep the niche gate. The 24–72 h tier (score 18) fired once (a losing alert), so there is nothing to tune there.
- **CSM: no change.** Raising `min_fill_usd` or tightening `longshot_max_price` below 0.20 would cut the part that shows edge. Raising `min_fill_to_wallet_volume_ratio` does nothing. Do not raise its score to deliver alone: that would add about 1 alert per control market-day (71 control firings over 73 market-days) at ≈ 0¢ edge. Revisit when live n reaches about 500.
- **FWL: keep delivered as is.**

Caveats: the attribution for some new cases is reporting-level, not market-level (Jun 23 ceasefire end-date, Hunter pardon timing, Gemini cut-off a day early for the AI Studio leak, Warsh cut-off at the Jan 29 reports). The Mar 31 ceasefire control had reported (losing) suspicious bets. Sibling controls are correlated with their cases. Prices come from the taker tape, not CLOB mid. ctl-openai-hardware-2025 has only 3 window trades. Sybil clusters are still not replayed. The "Shadow signal" section that finding 6 refers to has been replaced by the per-signal table, since FWL now delivers.

## Findings (hand-written, 2026-10-16; `omen backtest` regenerates everything above and keeps this block)

1. **Shipped config: 2/7 hits, median lead 24.4 h, 0/6 control FPs.** Hits are the two low-liquidity markets (Nobel/Machado: HIGH, 10.2 h before the announcement, from a 0.1 h-old wallet buying YES at 0.10 on $5.8k of 24 h volume; OpenAI browser: MEDIUM, 38.7 h). Misses are the liquid geopolitical markets (Maduro, Iran ×2, ceasefire) and d4vd.
2. **Why the liquid cases miss.** `FRESH_WALLET_LARGE_POSITION` only runs below `niche_max_volume` ($100k/24 h), and its size bar is max($1k, 2% of 24 h volume) — $25-60k in the Iran/ceasefire markets. The reported fresh wallets bet $0.5-3k per fill (Iran: Lettucehead718 / suffix-295 stayed CLEAN). `LUMP_ENTRY` and `CONVICTION_SIZE_MISMATCH` need prior volume, so a brand-new wallet's first bet cannot trigger them. What fires there is LUMP+CONVICTION = 22 (LOW), which shows up just as often on controls (33 LOW alerts across 5/6 controls, all on the losing side). It flags longshot buyers in general, not informed ones.
3. **Reported wallets.** The Maduro wallet (Burdensome-Mix) reached LOW 87 h before the news ($5k YES at 0.068: outsized + lump + conviction = 34). It stayed below MEDIUM because the market was not niche, so fresh-wallet could not add points, and because the wallet was 4-6 days old. AlphaRaccoon (d4vd) was renamed and cannot be matched by name in the tape.
4. **What-ifs on the same data.** (a) Dropping the niche gate gives 4/7 hits but 2/6 control FPs, which is not worth it. (b) A fresh-wallet longshot probe: wallet < 24 h old, ≤ 10 txns, effective price < 0.30, stake ≥ $5k, any market size. It fired on the winning side in 4/7 cases (Maduro 8.3 h, Iran Feb 28 56.8 h, ceasefire 16.6 h, Iran Jun 21 21.9 h lead) and only once on a control (Trump-Nobel, losing side). It fired on the losing side once in an insider market (OpenAI browser, a $5k+ NO).
5. **Gaps.** Sybil/funding clusters are not replayed (they need Alchemy), and they are the documented pattern in the Iran Feb 28 and ceasefire cases. Wallet age here comes from Polymarket activity, not on-chain data. n is small (7 + 6), so treat the rates as directional.

6. **Shipped in shadow mode (2026-10-16).** `FRESH_WALLET_LONGSHOT` is live with `[signals.fresh_wallet_longshot] deliver = false` (score 40 = MEDIUM alone). Replayed as if delivered (section "Shadow signal" above): on its own 4/7 winning-side hits (median lead 19.2 h) and 1/6 controls (Trump-Nobel, losing side); combined with the shipped signals 6/7 hits and 1/6 control FPs. The shipped headline is unchanged (2/7, 0/6) because shadow signals do not count toward delivery.

**Recommended next step (done, shadow):** add a `FRESH_WALLET_LONGSHOT` live signal using the probe above (stake ≥ $5k, age < 24 h, ≤ max_txns, effective price < 0.30, no niche or relative-size gate) scored high enough to reach MEDIUM on its own. Re-run `omen backtest`, and grade it in M1 outcomes for 2 weeks before raising it to Telegram.
<!-- findings:end -->
