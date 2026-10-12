# Kalshi (M2)

Read-only Kalshi ingest inside omen, behind `[kalshi] enabled`. It uses only the public REST API at
`https://api.elections.kalshi.com/trade-api/v2` (trades, markets, candlesticks). **No API key is needed.** The
WebSocket feed needs authenticated keys, so omen polls REST instead. Requests are spaced 150 ms apart and back off on 429.
Multivariate parlay tickers (`KXMVE*`) are ignored.

## Loops
- **Trades, every 15s:** `min_ts` overlaps the previous poll by 30s and trade ids are deduped. Every trade is added to
  `kalshi_hourly_volume`. Prints of at least `store_min_notional_usd` ($250) and all exchange block trades go to
  `kalshi_trades`.
- **Markets, every 60s:** refresh metadata for active tickers. Snapshot top-of-book for the mapped tickers plus the
  `book_watchlist_size` hottest tickers. Then evaluate volume spikes, book moves and divergence. Old rows are pruned hourly.

## Signals (stored in `kalshi_signals`, never dispatched)
| id | rule |
|---|---|
| KALSHI_BLOCK_TRADE | exchange `is_block_trade`, or a print of at least `large_print_usd` ($10k); direction is the taker side |
| KALSHI_VOLUME_SPIKE | current-hour notional vs the 7-day time-of-day baseline (same logic as Polymarket); needs at least 24h of history and at least $5k this hour |
| KALSHI_BOOK_MOVE | mid moves by 8c or more within 15 min, or one side's top-of-book size drops by 70% or more |
| CROSS_VENUE_DIVERGENCE | the YES gap on a mapped pair is at least 0.06; the signal points the Kalshi price toward Polymarket |

## Grading
Signals are enrolled in `trade_outcomes` with `venue='kalshi'`, `delivery_tier='KALSHI'`, and token and market id
both set to the ticker. BUY means the signal expects YES to rise.
- **Baseline:** ordinary (non-block, non-signal) stored prints on the same ticker within ±6h, at 0.5–2x the signal's size when it has one.
- **Price at +1h and +24h:** from candlesticks (YES bid/ask mid), falling back to the nearest stored print.
- **Resolution:** the market's `result` (yes = 1, no = 0).

`omen stats` shows these rows under the KALSHI tier and the Kalshi signal ids.

## Mapping markets
```
omen kalshi-map list
omen kalshi-map add <polymarketConditionId> <KALSHI-TICKER> [--invert] [--note "text"]
omen kalshi-map remove <polymarketConditionId> <KALSHI-TICKER>
```
Only map markets that are strictly equivalent (same event, same resolution criteria). Use `--invert` when Kalshi YES equals Polymarket NO.

### Suggesting pairs
```
omen kalshi-map suggest [--min 0.6] [--pm-limit 3000] [--kalshi-pages 60] [--json] [--auto]
```
This compares the top Polymarket markets by 24h volume (Gamma) with open Kalshi markets. For each Polymarket market it
lists the best Kalshi candidate and a confidence score:
- **confidence** = 0.7 × token Jaccard + 0.2 × date proximity + 0.1 × matching numbers.
- Halved when threshold numbers differ, and halved again when the dates are more than 30 days apart.
- Multiplied by 0.6 when one side has a qualifier the other lacks (vice/1st/anytime/most/seats/...) or names a
  different calendar day.

`EXACT` requires all of the following: binary Yes/No, the same numbers, no qualifier or date conflicts, a date gap of
36h or less, token similarity ≥ 0.85 and confidence ≥ 0.9. `--auto` adds only EXACT pairs. Even close candidates often
resolve differently (e.g. a BTC price at noon ET on Binance vs 5pm ET on CF Benchmarks), so check the rules before a
manual `add`.
