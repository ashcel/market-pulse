# EDR 0007: Stream the open token page's forming candle over WS (kline stream)

- **Status:** Accepted, implemented (2026-07-10)
- **Scope:** `src/lib/engine/binance-live-feed.ts` (generalized to a second stream kind), new `src/stores/live-klines.ts`, new `src/hooks/useLiveKline.ts`. Changed: `src/hooks/useLivePrice.ts` / `src/hooks/useLiveUniverseSubscription.ts` (call-site update for the now-discriminated `LiveWant` union), `src/lib/engine/binance.ts` (export `BINANCE_INTERVALS`), `src/routes/token.$symbol.tsx`.
- **Depends on:** EDR 0006 (unified live-price architecture) — this reuses its feed manager, registry, and per-market sockets rather than adding a third one.

## Problem

EDR 0006's follow-up fix (shared `anchorQuery`/`useLivePrice` per symbol+market in `useTokenSignal`) synchronized the _entry price_ across timeframe tabs, but not the klines themselves. Each timeframe's forming candle still came from `useTokenSignal`'s own REST refetch (~30-60s cadence per the query's `refetchInterval`) — so a higher timeframe (4H/1D/1W), which the user visits less often and whose bar spans much longer, visibly lagged behind what the market was actually doing between refetches. Reported directly: "the klines doesn't seem to be the same for higher TF."

## The chosen fix

**Reuse EDR 0006's feed manager; add a second stream kind rather than a third socket.** `binance-live-feed.ts`'s `LiveWant` becomes a discriminated union: `{kind:"ticker"}` (the existing miniTicker want) and `{kind:"kline"; timeframe}` (new). Both kinds resolve to a stream name and are multiplexed onto the _same_ two per-market sockets, sharing one connect URL, one reconnect path, one teardown — the whole point of EDR 0006's registry/reconcile design was that adding a new "thing to want" shouldn't require new infrastructure, only a new variant of `Want`.

`{kind:"kline"}` resolves to Binance's `<symbol>@kline_<interval>` stream, which reports the actual forming-candle OHLCV Binance computes for that one symbol+interval — something miniTicker structurally cannot provide (it only carries last price + 24h-ago open, no per-bar high/low/open). The internal registry/store key changed from the Binance interval string to the app's own `TokenTimeframe` (`"4H"` not `"4h"`) so the write side (feed manager) and read side (`useLiveKline`) can't drift on which vocabulary they're keying by — caught in review before shipping.

**New `live-klines.ts`** (non-persisted, same rationale as `live-prices.ts`) holds the live forming candle per `market:ticker:timeframe`. **New `useLiveKline(symbol, timeframe, enabled, market)`** subscribes only for whichever symbol+timeframe is currently open on the token page — never the whole UNIVERSE, since this is inherently a single-view concern.

**`token.$symbol.tsx`** now builds `liveCandle` as `liveKline ?? data.liveCandle` — the WS-sourced candle wins the instant it arrives; until then (or if the feed can't reach that symbol/interval), it falls back to `useTokenSignal`'s REST-derived candle exactly as before. Switching timeframe tabs unsubscribes the old interval and subscribes the new one (same idempotent-by-caller-id mechanism as everything else in the feed), so whichever tab is open is always the one getting the live kline.

## Why the engine evaluation itself doesn't re-run per tick

`evaluateSignal` (`quant.ts`) calls `runBacktest` over up to 1000 candles on every invocation — a real cost, not free. Recomputing it on every WS tick (roughly once a second) was considered and rejected: it would turn a bounded, ~30-60s-cadence computation into a continuous one for no benefit the ticket asked for. The live kline only overrides the _chart's rendered last bar_; the risk plan, backtest stats, and structure/regime classification stay on `useTokenSignal`'s existing REST refetch schedule, now anchored by EDR 0006's shared per-symbol+market price so it's at least consistent across tabs even between refetches.

## What was rejected

- **A third, kline-specific socket/manager** — rejected in favor of extending the existing multiplexed manager; the two-sockets-total invariant from EDR 0006 was worth preserving rather than special-casing kline streams.
- **Recomputing `evaluateSignal` reactively per tick** — see above; out of proportion to what was asked, and a real CPU cost on every tick for every open token page.
- **Keying the live-kline store by Binance's raw interval string** — caught in review: the feed manager derives the Binance interval only to build the stream name; the store itself is keyed by the app's `TokenTimeframe` end to end, so the write and read sides can never disagree on vocabulary.

## Assumptions and edge cases

- A freshly-opened timeframe tab shows the REST-derived candle until the kline stream's first tick arrives (typically well under the REST refetch interval) — no visible regression versus before, just a brief bootstrap window.
- `k.x` (Binance's closed-bar flag) is read into the store but not specially handled — the chart doesn't need a transition event; the next tick simply carries the next bar's `time`, and REST's own periodic refetch is what advances `candles`/backtest history.
- Volume in a kline frame is contract-scale for multiplier symbols (1000PEPE etc.), corrected by the same `priceScale` multiply used elsewhere in this feed.

## Verification performed

- `bunx tsc --noEmit` and `bun run lint` clean.
- SSR smoke test: `/token/BTC` still returns 200 with a fully rendered page after the change.
- Re-verified `/api/klines?symbol=PEPE&market=perp` still returns correctly-scaled candles — confirms the kline-stream refactor didn't disturb EDR 0006's REST-side scale correction.
- **Not verified in this pass** (same sandbox WS restriction as EDR 0006): actual live kline ticks arriving in a browser. Recommend: open a token page, switch to 4H or 1D, and watch the last candle's wick/close move between REST refetches instead of jumping only every 30-60s.

## Future extension points

- If the live kline ever needs to feed back into `evaluateSignal` (e.g. for a "live bias" indicator cheaper than a full backtest), that's a distinct, smaller computation to design — not a reason to make the full engine reactive.
