# M2 backtest: omen signals on reported Polymarket insider cases

Generated 2026-10-16T11:49:07.029Z by `omen backtest` (config `omen.config.toml`). Offline replay: no DB, Redis, Telegram, feed or Alchemy.

## Headline

- Insider cases: **2/7 hit** (a delivered MEDIUM+ alert on the winning side before the news).
- Median lead time of the first such alert: **24.4 h**.
- False-positive rate on controls: **0/6 (0%)** of control markets had ≥1 delivered MEDIUM+ alert; 0.00 such alerts per control market-day.
- In the insider markets, 40% of delivered MEDIUM+ alerts were on the losing side.

## Method

- **Data.** Polymarket data-api `/trades` (taker side, the feed omen ingests live) for each market from `windowStart − 24h` to the news cut-off, paged backwards by `end`; gamma `/markets` for metadata; data-api `/activity` (≤ 500 rows per page) for each wallet with a fill ≥ $250 (the lowest offline signal minimum). All responses cached under `.backtest-cache/`; reruns with `--offline` make no requests. No Alchemy calls, no Postgres/Redis, nothing sent to Telegram or the feed.
- **Replay.** Each candidate fill goes through the live path: `evaluateLiveSignals` → market-maker filter (`calculateMarketMakerScore` ≥ `market_maker.min_score`) → `computeCompositeLiveScore` → `deriveAlertTier` → 24 h per wallet+market dedup (re-alert on +`dedup_score_increase`). Thresholds come from `omen.config.toml` as committed.
- **Point-in-time inputs.** Market 24 h volume = the tape over the 24 h before each fill (gamma `volume24hr` has no history). Wallet totals, fill count, markets and market-maker score come from the wallet's Polymarket activity strictly before the fill. Wallet age = time since its first Polymarket activity (stand-in for the Alchemy first-transfer age; funding usually precedes the first trade by minutes to hours, so this reads slightly *fresher* than live). When the activity pages cannot see a fill's full prior history the wallet gets omen's conservative profile (fresh-wallet, lump and conviction cannot fire), as live does on a degraded profile.
- **Not evaluated.** `SYBIL_CLUSTER` (needs Alchemy funding graphs) is off in the replay, so cluster-style cases (Iran Feb 28, ceasefire Apr 7) are scored without it.
- **Scoring.** Hit = a delivered MEDIUM+ alert (the Telegram tiers) on the side that won, before the news cut-off. Lead = news − first such alert. FP rate = control markets with ≥ 1 delivered MEDIUM+ alert. LOW alerts are promoted to the feed for grading but not delivered, so they count in the tier columns only.
- **Cut-offs.** News times are the first public signal from the linked reporting (UTC), rounded; see each case. Controls use a same-length window before expiry.

## Per case

| Case | Kind | Window trades / volume | Hit | Best winning-side tier | Lead (first hit) | Lead (first any alert) | Delivered alerts by tier (C/H/M/L) | Signals fired | Reported wallet flagged |
|---|---|---|---|---|---|---|---|---|---|
| nobel-machado-2025 | insider | 3,093 / $983,839 | **HIT** | HIGH | 10.2 h | 10.2 h | 0/1/0/5 | OUTSIZED_POSITION×6, NICHE_MARKET_ENTRY×3, CONVICTION_SIZE_MISMATCH×1, FRESH_WALLET_LARGE_POSITION×1, LUMP_ENTRY×5 | n/a |
| openai-browser-oct31 | insider | 6,457 / $1,527,679 | **HIT** | MEDIUM | 38.7 h | 82.2 h | 0/0/3/14 | OUTSIZED_POSITION×10, NICHE_MARKET_ENTRY×4, LUMP_ENTRY×15, FRESH_WALLET_LARGE_POSITION×3, CONVICTION_SIZE_MISMATCH×7, FRESH_WALLET_LONGSHOT×1 | n/a |
| d4vd-year-in-search | insider | 4,044 / $1,815,360 | miss | LOW | — | 14.9 h | 0/0/0/4 | LUMP_ENTRY×4, CONVICTION_SIZE_MISMATCH×3, OUTSIZED_POSITION×1 | not found in tape |
| maduro-out-jan31 | insider | 1,818 / $612,323 | miss | LOW | — | 87.1 h | 0/0/0/5 | LUMP_ENTRY×5, CONVICTION_SIZE_MISMATCH×4, OUTSIZED_POSITION×2 | no |
| us-strikes-iran-feb28 | insider | 23,778 / $10,490,941 | miss | LOW | — | 57.8 h | 0/0/0/34 | LUMP_ENTRY×34, CONVICTION_SIZE_MISMATCH×33, OUTSIZED_POSITION×1, FRESH_WALLET_LONGSHOT×1 | no |
| us-iran-ceasefire-apr7 | insider | 18,651 / $5,625,905 | miss | LOW | — | 42.3 h | 0/0/0/4 | LUMP_ENTRY×4, CONVICTION_SIZE_MISMATCH×4 | n/a |
| us-action-iran-jun21 | insider | 2,245 / $904,453 | miss | LOW | — | 37.4 h | 0/0/1/5 | OUTSIZED_POSITION×2, NICHE_MARKET_ENTRY×2, FRESH_WALLET_LARGE_POSITION×1, LUMP_ENTRY×5, CONVICTION_SIZE_MISMATCH×4 | n/a |
| ctl-maduro-out-2025 | control | 3,860 / $2,047,555 | clean | CLEAN | — | 20.5 h | 0/0/0/1 | LUMP_ENTRY×1, CONVICTION_SIZE_MISMATCH×1 | n/a |
| ctl-maduro-out-nov30 | control | 2,185 / $1,141,877 | clean | LOW | — | 90.7 h | 0/0/0/1 | OUTSIZED_POSITION×1, NICHE_MARKET_ENTRY×1, LUMP_ENTRY×1 | n/a |
| ctl-openai-browser-sep30 | control | 320 / $48,610 | clean | CLEAN | — | — | 0/0/0/0 | — | n/a |
| ctl-trump-nobel-2025 | control | 4,825 / $1,998,820 | clean | CLEAN | — | 67.5 h | 0/0/0/9 | LUMP_ENTRY×9, CONVICTION_SIZE_MISMATCH×9 | n/a |
| ctl-us-strikes-iran-jan31 | control | 15,375 / $5,503,079 | clean | CLEAN | — | 92.7 h | 0/0/0/20 | LUMP_ENTRY×20, CONVICTION_SIZE_MISMATCH×19, OUTSIZED_POSITION×1 | n/a |
| ctl-us-iran-ceasefire-mar31 | control | 2,724 / $1,888,022 | clean | CLEAN | — | 22.7 h | 0/0/0/2 | OUTSIZED_POSITION×2, LUMP_ENTRY×2 | n/a |

### What-if (not shipped): FRESH_WALLET without the niche gate (detection.market.niche_max_volume = ∞)

Hits **4/7**, median lead 16.1 h, controls with a MEDIUM+ alert **2/6** (0.14/market-day), losing-side share in insider markets 29%.

| Case | Hit | Best winning-side tier | Lead (first hit) | Delivered MEDIUM+ (winning / losing) |
|---|---|---|---|---|
| nobel-machado-2025 | **HIT** | HIGH | 10.2 h | 3 / 0 |
| openai-browser-oct31 | **HIT** | MEDIUM | 38.7 h | 9 / 3 |
| d4vd-year-in-search | miss | LOW | — | 0 / 0 |
| maduro-out-jan31 | **HIT** | MEDIUM | 8.3 h | 2 / 0 |
| us-strikes-iran-feb28 | miss | LOW | — | 0 / 1 |
| us-iran-ceasefire-apr7 | miss | LOW | — | 0 / 0 |
| us-action-iran-jun21 | **HIT** | MEDIUM | 21.9 h | 1 / 2 |
| ctl-maduro-out-2025 | clean | CLEAN | — | 0 / 0 |
| ctl-maduro-out-nov30 | clean | LOW | — | 0 / 0 |
| ctl-openai-browser-sep30 | clean | CLEAN | — | 0 / 0 |
| ctl-trump-nobel-2025 | FP | MEDIUM | 19.6 h | 1 / 0 |
| ctl-us-strikes-iran-jan31 | FP | MEDIUM | 73.2 h | 2 / 0 |
| ctl-us-iran-ceasefire-mar31 | clean | CLEAN | — | 0 / 0 |

### Shadow signal: FRESH_WALLET_LONGSHOT (recorded + graded live, not delivered; replayed here as if delivered)

- On its own: fired on the winning side before the news in **4/7** insider cases (median lead 19.2 h); fired on **1/6** controls; fired on the losing side in 1 insider case(s).
- Combined with the shipped signals, if delivered: **6/7** hits, median lead 19.2 h, controls with a MEDIUM+ alert **1/6**.

| Case | Kind | Fired (winning / losing) | Lead (first winning) | Combined hit if delivered |
|---|---|---|---|---|
| nobel-machado-2025 | insider | 0 / 0 | — | **HIT** |
| openai-browser-oct31 | insider | 0 / 1 | — | **HIT** |
| d4vd-year-in-search | insider | 0 / 0 | — | miss |
| maduro-out-jan31 | insider | 2 / 0 | 8.3 h | **HIT** |
| us-strikes-iran-feb28 | insider | 13 / 0 | 56.8 h | **HIT** |
| us-iran-ceasefire-apr7 | insider | 2 / 0 | 16.6 h | **HIT** |
| us-action-iran-jun21 | insider | 1 / 0 | 21.9 h | **HIT** |
| ctl-maduro-out-2025 | control | 0 / 0 | — | clean |
| ctl-maduro-out-nov30 | control | 0 / 0 | — | clean |
| ctl-openai-browser-sep30 | control | 0 / 0 | — | clean |
| ctl-trump-nobel-2025 | control | 0 / 1 | — | FP |
| ctl-us-strikes-iran-jan31 | control | 0 / 0 | — | clean |
| ctl-us-iran-ceasefire-mar31 | control | 0 / 0 | — | clean |

### What-if probe (not shipped): fresh wallet (< 24 h, ≤ max_txns) longshot (< 0.30) at any market size

Counts of probe fills before the news, winning side / losing side, by minimum stake. Lead = news minus first winning-side probe fill.

| Case | ≥ $2,500 (win / lose, lead) | ≥ $5,000 (win / lose, lead) | ≥ $10,000 (win / lose, lead) |
|---|---|---|---|
| nobel-machado-2025 (insider) | 0 / 0 | 0 / 0 | 0 / 0 |
| openai-browser-oct31 (insider) | 0 / 1 | 0 / 1 | 0 / 0 |
| d4vd-year-in-search (insider) | 0 / 0 | 0 / 0 | 0 / 0 |
| maduro-out-jan31 (insider) | 2 / 0, 8.3 h | 2 / 0, 8.3 h | 0 / 0 |
| us-strikes-iran-feb28 (insider) | 18 / 0, 56.8 h | 13 / 0, 56.8 h | 4 / 0, 38.1 h |
| us-iran-ceasefire-apr7 (insider) | 3 / 0, 16.6 h | 2 / 0, 16.6 h | 0 / 0 |
| us-action-iran-jun21 (insider) | 1 / 0, 21.9 h | 1 / 0, 21.9 h | 0 / 0 |
| ctl-maduro-out-2025 (control) | 0 / 0 | 0 / 0 | 0 / 0 |
| ctl-maduro-out-nov30 (control) | 0 / 0 | 0 / 0 | 0 / 0 |
| ctl-openai-browser-sep30 (control) | 0 / 0 | 0 / 0 | 0 / 0 |
| ctl-trump-nobel-2025 (control) | 0 / 4 | 0 / 1 | 0 / 1 |
| ctl-us-strikes-iran-jan31 (control) | 0 / 6 | 0 / 0 | 0 / 0 |
| ctl-us-iran-ceasefire-mar31 (control) | 0 / 0 | 0 / 0 | 0 / 0 |

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
| 2025-10-20 01:19 | darda412 | YES ✓ @ 0.408 | $1,326 | $25,965 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-10-20 02:38 | 0x79475AcbB782588D9dffC91f2819Eb6b67d7eb3d-1759866677948 | YES ✓ @ 0.396 | $1,499 | $31,616 | 0.0 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-10-20 09:35 | 0x8245E70DCF5C2bD5125d0c3a45D3568E28C94F87-1760736824219 | NO @ 0.359 | $1,712 | $85,147 | 40.0 h | 45 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-10-18 05:48 | ughiuyfgiuuy | YES ✓ @ 0.418 | $1,977 | $20,121 | 6493.3 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |
| 2025-10-21 06:33 | scalpgoblin | NO @ 0.145 | $1,300 | $594,499 | 54.2 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

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
| 2026-01-01 23:57 | 0x31a56e9E61eD21De08Cbe9524Cdb8eD9-0765984 | YES ✓ @ 0.068 | $5,000 | $165,117 | 138.9 h | 34 / LOW | OUTSIZED_POSITION, LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-12-30 14:52 | 154x838hjd6 | YES ✓ @ 0.074 | $1,390 | $148,984 | 11.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-12-31 00:20 | 0x31a56e9E61eD21De08Cbe9524Cdb8eD9-0765984 | YES ✓ @ 0.090 | $1,238 | $140,155 | 91.2 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-12-31 07:44 | 0x5fe10daa | YES ✓ @ 0.100 | $2,000 | $137,512 | 109.8 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-01-03 00:33 | babymoore | NO @ 0.940 | $5,363 | $118,995 | 200.9 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

### us-strikes-iran-feb28: US strikes Iran by February 28, 2026?

- Condition `0x3488f31e6449f9803f99a8b5dd232c7ad883637f1c86e6953305a2ef19c77f20`; winner YES.
- Window 2026-02-25T06:30:00Z → news 2026-02-28T06:30:00Z (First strike reports ~06:30 UTC (CENTCOM 06:35 UTC)).
- 5488 candidate fills evaluated; 2413 wallets profiled from Polymarket activity.
- Sources: [Forbes, 2026-03-02](https://www.forbes.com/sites/boazsobrado/2026/03/02/fresh-wallets-made-12m-on-polymarket-hours-before-iran-airstrikes/); [CoinDesk, 2026-02-28](https://www.coindesk.com/markets/2026/02/28/suspected-insiders-make-over-usd1-2-million-on-polymarket-ahead-of-u-s-strike-on-iran)
- Reported wallet fills in window: 8 ($11,853); best tier CLEAN.

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-02-25 20:42 | 0xDAEfCd102d9F3E1626CF49302b65c9073d5EE647-1772047421723 | YES ✓ @ 0.110 | $2,000 | $1,551,563 | 0.4 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-02-26 18:22 | SHA1024 | YES ✓ @ 0.160 | $1,338 | $1,276,881 | 1.0 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-02-26 18:35 | Gdruid | YES ✓ @ 0.160 | $500 | $1,290,134 | 0.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-02-26 21:44 | Planktonbets | YES ✓ @ 0.100 | $6,000 | $1,966,017 | 208.2 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-02-27 11:29 | Harpouching | YES ✓ @ 0.160 | $980 | $2,786,807 | 71.4 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### us-iran-ceasefire-apr7: US x Iran ceasefire by April 7?

- Condition `0x4c5701bcde0b8fb7d7f48c8e9d20245a6caa58c61a77f981fad98f2bfa0b1bc7`; winner YES.
- Window 2026-04-05T22:30:00Z → news 2026-04-07T22:30:00Z (Trump Truth Social post ~18:30 ET).
- 4549 candidate fills evaluated; 1745 wallets profiled from Polymarket activity.
- Sources: [AP News](https://apnews.com/article/polymarket-iran-trump-ceasefire-prediction-markets-350d9fe5ffefa74080ff5dd973aef48b); [Reuters factbox, 2026-04-08](https://www.reuters.com/sustainability/boards-policy-regulation/some-trades-ahead-trump-policy-moves-raise-questions-2026-04-08/)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-04-06 04:10 | pronigga | YES ✓ @ 0.056 | $3,000 | $1,108,751 | 13736.7 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-04-06 21:07 | 0x755519c3A4a69469F488197fBD39B12f70B3EcC5-1775507911807 | YES ✓ @ 0.032 | $1,467 | $1,733,449 | 0.3 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-04-07 14:06 | The-insider-formerly-known-as-25xp | YES ✓ @ 0.043 | $4,168 | $1,517,228 | 0.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2026-04-07 19:49 | Zaneraza13 | YES ✓ @ 0.146 | $2,895 | $1,813,172 | 48.7 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

### us-action-iran-jun21: US military action against Iran by Saturday? (2025-06-21)

- Condition `0x6c6cff89b135f5684f5a25a98fd0335814d1bc411d08bfcf0be400db76ce511a`; winner YES.
- Window 2025-06-18T23:50:00Z → news 2025-06-21T23:50:00Z (Trump announced the Fordow/Natanz strikes ~19:50 ET).
- 851 candidate fills evaluated; 357 wallets profiled from Polymarket activity.
- Sources: [ACDC, Insider Risks in Polymarket Political Markets (Apr 2026)](https://acdatacollective.org/wp-content/uploads/2026/04/Insider_Risks_in_Polymarket_Political_Markets_ACDC.pdf)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2025-06-20 10:25 | Lupaed67 | NO @ 0.940 | $1,156 | $19,700 | 22.2 h | 49 / MEDIUM | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, FRESH_WALLET_LARGE_POSITION |
| 2025-06-20 13:38 | xiri | NO @ 0.920 | $1,200 | $36,248 | 4059.4 h | 27 / LOW | OUTSIZED_POSITION, NICHE_MARKET_ENTRY, LUMP_ENTRY |
| 2025-06-21 06:24 | B2twarminius | YES ✓ @ 0.070 | $609 | $174,905 | 0.2 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-06-21 14:34 | Lol123555 | YES ✓ @ 0.124 | $5,805 | $303,859 | 214.3 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-06-21 21:23 | 0x146d2E945e427d219aB4f1d779D77Ff5B3409307-1750251652381 | YES ✓ @ 0.102 | $3,997 | $555,807 | 78.9 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

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
| 2025-10-07 13:28 | 0xFEbb4b3d8a3B330ffBE5320FEF63B770d0374016-1759842762347 | YES @ 0.027 | $500 | $212,547 | 0.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-10-08 17:23 | ivan | YES @ 0.028 | $1,000 | $146,175 | 11957.3 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-10-09 10:17 | 0xe1C13e13e5209F2FBe5121F91861BF41c735aE78-1759861090207 | YES @ 0.066 | $501 | $299,688 | 0.6 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-10-09 13:10 | moeks | YES @ 0.067 | $1,238 | $466,965 | 261.1 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |
| 2025-10-09 13:39 | Dorius | YES @ 0.057 | $1,000 | $874,084 | 0.0 h | 22 / LOW | LUMP_ENTRY, CONVICTION_SIZE_MISMATCH |

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
- Window 2026-03-29T23:59:00Z → news 2026-03-31T23:59:00Z (Expired No).
- 937 candidate fills evaluated; 578 wallets profiled from Polymarket activity.
- Sources: [Polymarket](https://polymarket.com/event/us-x-iran-ceasefire-by)

| Time (UTC) | Wallet | Side @ price | Size | Mkt 24h vol | Wallet age | Score / tier | Signals |
|---|---|---|---|---|---|---|---|
| 2026-03-31 01:16 | 0x436f969D99c90191fBC2c629e6B7a1B754402c7F-1772236065502 | YES @ 0.008 | $75,031 | $885,310 | 234.5 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |
| 2026-03-31 22:13 | kylez41 | YES @ 0.004 | $24,306 | $919,596 | 442.2 h | 20 / LOW | OUTSIZED_POSITION, LUMP_ENTRY |

<!-- findings:start (hand-written; `omen backtest` keeps this block) -->
## Findings (hand-written, 2026-10-16; `omen backtest` regenerates everything above and keeps this block)

1. **Shipped config: 2/7 hits, median lead 24.4 h, 0/6 control FPs.** Hits are the two low-liquidity markets (Nobel/Machado: HIGH, 10.2 h before the announcement, from a 0.1 h-old wallet buying YES at 0.10 on $5.8k of 24 h volume; OpenAI browser: MEDIUM, 38.7 h). Misses are the liquid geopolitical markets (Maduro, Iran ×2, ceasefire) and d4vd.
2. **Why the liquid cases miss.** `FRESH_WALLET_LARGE_POSITION` only runs below `niche_max_volume` ($100k/24 h), and its size bar is max($1k, 2% of 24 h volume) — $25-60k in the Iran/ceasefire markets. The reported fresh wallets bet $0.5-3k per fill (Iran: Lettucehead718 / suffix-295 stayed CLEAN). `LUMP_ENTRY` and `CONVICTION_SIZE_MISMATCH` need prior volume, so a brand-new wallet's first bet cannot trigger them. What fires there is LUMP+CONVICTION = 22 (LOW), which shows up just as often on controls (33 LOW alerts across 5/6 controls, all on the losing side). It flags longshot buyers in general, not informed ones.
3. **Reported wallets.** The Maduro wallet (Burdensome-Mix) reached LOW 87 h before the news ($5k YES at 0.068: outsized + lump + conviction = 34). It stayed below MEDIUM because the market was not niche, so fresh-wallet could not add points, and because the wallet was 4-6 days old. AlphaRaccoon (d4vd) was renamed and cannot be matched by name in the tape.
4. **What-ifs on the same data.** (a) Dropping the niche gate gives 4/7 hits but 2/6 control FPs, which is not worth it. (b) A fresh-wallet longshot probe: wallet < 24 h old, ≤ 10 txns, effective price < 0.30, stake ≥ $5k, any market size. It fired on the winning side in 4/7 cases (Maduro 8.3 h, Iran Feb 28 56.8 h, ceasefire 16.6 h, Iran Jun 21 21.9 h lead) and only once on a control (Trump-Nobel, losing side). It fired on the losing side once in an insider market (OpenAI browser, a $5k+ NO).
5. **Gaps.** Sybil/funding clusters are not replayed (they need Alchemy), and they are the documented pattern in the Iran Feb 28 and ceasefire cases. Wallet age here comes from Polymarket activity, not on-chain data. n is small (7 + 6), so treat the rates as directional.

6. **Shipped in shadow mode (2026-10-16).** `FRESH_WALLET_LONGSHOT` is live with `[signals.fresh_wallet_longshot] deliver = false` (score 40 = MEDIUM alone). Replayed as if delivered (section "Shadow signal" above): on its own 4/7 winning-side hits (median lead 19.2 h) and 1/6 controls (Trump-Nobel, losing side); combined with the shipped signals 6/7 hits and 1/6 control FPs. The shipped headline is unchanged (2/7, 0/6) because shadow signals do not count toward delivery.

**Recommended next step (done, shadow):** add a `FRESH_WALLET_LONGSHOT` live signal using the probe above (stake ≥ $5k, age < 24 h, ≤ max_txns, effective price < 0.30, no niche or relative-size gate) scored high enough to reach MEDIUM on its own. Re-run `omen backtest`, and grade it in M1 outcomes for 2 weeks before raising it to Telegram.
<!-- findings:end -->
