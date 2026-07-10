# Dreimann ground-truth fixtures

Frozen Binance **USDT-M perpetual** klines (the venue the source charts were
drawn on; the app itself consumes spot klines) plus hand-transcribed labels for
the example trades in `research/dreimann/`. Captured 2026-07-10 by
`research/scripts/fetch-dreimann-fixtures.ts`; tests read the committed JSON
and never fetch.

**These fixtures validate logic correctness only — do we derive the same
pivots, strength types, and premium/discount reads the trader drew? No numeric
threshold may ever be tuned against them** (risk R5, `research/analysis.md`
§8): 6 bullish pullback longs from one trader in one week is an archetype
sample, not a tuning set.

## Trades

| Fixture    | Chart                 | Symbol · TF (exec) | Window (UTC)        | Entry              | Stop    | Objective            | Outcome |
| ---------- | --------------------- | ------------------ | ------------------- | ------------------ | ------- | -------------------- | ------- |
| `zec-tp`   | `zec_hit_tp.png`      | ZECUSDT · 15m      | Jul 05 → Jul 10     | market 462.74      | 454.73  | 487.0 (weak high)    | TP      |
| `trx-tp3`  | `trx_hit_tp_max.png`  | TRXUSDT · 15m      | Jul 05 → Jul 10     | market 0.32782     | 0.32653 | 0.33181 (weak high)  | TP3     |
| `zec-sl`   | `zec_hit_sl.png`      | ZECUSDT · 4h       | Jun 15 → Jul 09     | limit 450.49       | 446.05  | 463.79 (weak high)   | SL      |
| `ethfi-sl` | `ethfi_hit_sl.png`    | ETHFIUSDT · 1h     | Jun 28 → Jul 10     | limit 0.4245       | 0.4078  | 0.4746 (beyond window) | SL    |
| `jup-tp`   | `jup_hit_tp.png`      | JUPUSDT · 1h       | Jun 25 → Jul 08     | limit 0.2340       | 0.2281  | 0.2519 (weak high)   | TP (2R) |
| `fet-tp`   | `fet_hit_tp_max.png`  | FETUSDT · 15m      | Jun 28 → Jul 04     | limit 0.1773\*     | 0.1755\* | 0.1827\* (weak high) | TP      |

Every fixture also carries a `4h` context series with extra left margin so H4
structure can form before the chart window opens.

## Caveats a reviewer should check against the PNGs

- **Entry times are approximate.** Charts give a box edge, not a timestamp;
  each `approxTimeUtc` is pinned to the first fixture bar consistent with the
  chart (first bar trading through a limit, or the position-tool's left edge
  for market entries). Fidelity tests must treat them as ±a few bars, never
  exact.
- **`fet-tp` (\*):** trades.txt records 0.1708 / 0.1673 / 0.1813, which do not
  match the chart's position tool (0.1773 / 0.1755 / 0.1827) — likely a
  different attempt on the same setup. The chart-visible levels are used
  because the labels annotate the chart; the discrepancy is preserved in
  `labels.json`.
- **`ethfi-sl` objective (0.4746)** sits above every high in the fetched
  window, so it cannot be asserted as a weak high from this data
  (`withinWindow: false`); the trade still contributes entry/stop/discount
  labels and the Counter-Internal case.
- **HYPE is excluded.** Its chart is a MEXC perp (another venue's prices —
  substituting Binance data would silently shift every level) and trades.txt
  records no absolute entry/stop/target for it, leaving nothing to validate.

## Files

- `<trade>.json` — `{ meta, series: { "<tf>": Candle[] } }`, `Candle.time` in
  unix **seconds** (engine convention).
- `labels.json` — the ground-truth annotations. Treat as data under review,
  not code: it is the acceptance bar for the Phase 0 fidelity tests.
- `index.ts` — typed loader (`loadDreimannFixture`).
