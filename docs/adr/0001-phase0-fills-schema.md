# ADR 0001: Phase 0 Fills Ledger Natural Key

## Status

Pending live validation.

This ADR is intentionally provisional until a real 24-hour capture run has been completed
with `omen validate-fills capture` and analyzed with `omen validate-fills analyze`.

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

`(match_time, bucket_index, asset)` is a reconciliation helper, not a row key, because the
docs state a single logical trade can span multiple onchain transactions.

## Required Evidence Before Status Can Change To Accepted

- 24-hour raw capture directory produced by the Phase 0 CLI
- Generated `analysis/summary.json`
- Generated `analysis/findings.md`
- Order-type inference coverage and, if auth data is present, inferred-vs-auth accuracy
- Explicit note on whether public polling caused duplicate observations that had to be collapsed

## Current Default

No schema decision is locked yet.

The committed sample fixture is only a deterministic test harness. It is not sufficient
evidence to finalize the Phase 1 `fills` table key on its own.
