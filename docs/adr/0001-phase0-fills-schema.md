# ADR 0001: Phase 0 Fills Ledger Natural Key

## Status

Accepted on 2026-03-30.

## Context

The `fills` ledger is the Phase 1 source of truth. If the natural key is wrong, replay,
signal idempotency, and every derived wallet/profile computation inherit corrupted input.

Phase 0 exists to answer five questions before any application ledger code is written:

1. Does public `data-api /trades` expose enough fields to identify a fill naturally?
2. Is `(txHash, tokenId)` unique per fill in real traffic?
3. Do partial fills or batched executions create same-tx same-token collisions?
4. Does authenticated trade history expose a better fill identifier?
5. How reliable is order-type inference from captured orderbook snapshots?

## Inputs

- Gamma discovery: active markets and `clobTokenIds`
- Public trades: `https://data-api.polymarket.com/trades`
- Public orderbooks: `https://clob.polymarket.com/books`
- Public market WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Optional authenticated trades: `@polymarket/clob-client` `getTrades()`

## Decision Rule

Lock the Phase 1 fills natural key using the strongest result below:

1. Prefer authenticated `trade.id` if it is available for the validation path and stays unique.
2. Otherwise accept `(txHash, asset)` only if the 24-hour public sample shows zero collisions.
3. Otherwise accept `(txHash, asset, price)` only if collisions disappear there.
4. Otherwise keep the schema unresolved and continue Phase 0 evidence gathering.

For this ADR, "available for the validation path" means more than a token sample. A unique auth
ID only outranks the public key candidates when the capture contains at least 10 unique auth
trades; smaller samples are treated as informative but not strong enough to lock the Phase 1 row key.

`(match_time, bucket_index, asset)` is a reconciliation helper, not a row key, because the
docs state a single logical trade can span multiple onchain transactions.

## Required Evidence Before Status Can Change To Accepted

- 24-hour raw capture directory produced by the Phase 0 CLI
- Generated `analysis/summary.json`
- Generated `analysis/findings.md`
- Order-type inference coverage and, if auth data is present, inferred-vs-auth accuracy
- Explicit note on whether public polling caused duplicate observations that had to be collapsed

## Decision

Use `(txHash, asset)` as the Phase 1 `fills` ledger natural key.

Do not lock `AUTH_TRADE_ID` from the current live run. The authenticated stream produced only 3
unique trades, which is enough to confirm the field exists but not enough to outweigh a much larger
public sample.

## Live Validation Evidence

Validated from a local `.phase0-data/overnight-24h` capture:

- 24-hour capture window from `2026-03-28T11:08:39.057Z` to `2026-03-29T11:08:39.064Z`
- 305,450 public trade observations and 305,450 unique public trades
- 0 duplicate public observations collapsed across polling windows
- 0 `txHash + asset` collision groups across the full public sample
- 0 `txHash + asset + price` collision groups across the full public sample
- 3 authenticated trade observations and 3 unique auth trade IDs, all unique but below the minimum validation sample
- 0 same-tx same-asset repeats and 0 same-tx same-asset different-price cases
- 57,387 order-book snapshots and 132,751 market WebSocket messages captured
- 1,367 public trades could be order-type inferred; 304,083 remained unknown
- Auth inferred-vs-auth accuracy remained unavailable because 0 auth trades had comparable inferred order type

## Notes

- `capture.log` recorded three exhausted public-trade fetch retries during the 24-hour run. The capture still completed, line counts matched the manifest exactly, and the public sample showed zero duplicate observations, so this does not change the schema decision under a pragmatic gate.
- Order-type inference coverage is too weak to use as a Phase 1 invariant. It remains a best-effort enrichment signal, not part of the fills row key decision.

The committed sample fixture is only a deterministic test harness. It is not sufficient
evidence to finalize the Phase 1 `fills` table key on its own.
