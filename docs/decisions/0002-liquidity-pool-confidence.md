# EDR 0002: Liquidity pools derived from EQH/EQL clusters, with an explainable three-component confidence

- **Status:** Accepted, implemented (2026-07-09)
- **Scope:** `src/lib/engine/liquidity.ts` (new), `SignalEvaluation.liquidity` exposure in `quant.ts`, chart price-line rendering and AI-analyst context
- **Depends on:** the EQH/EQL detection in `structure.ts` (see EDR 0001's lineage: the MarketStructure model and its replay-safety rules)

## Problem

Equal highs and equal lows are not just chart patterns — they are order-book facts. Stops from shorts and breakout buy orders accumulate just above a double top (buy-side liquidity, BSL); longs' stops and breakdown sell orders accumulate just below a double bottom (sell-side liquidity, SSL). Price is routinely drawn toward these levels. The engine detects the clusters (`MarketStructure.equalHighs/equalLows`) but nothing turned them into ranked, tradeable levels: which pools still hold orders, and which matter most.

## Decision

A new pure module `liquidity.ts` maps each EQH cluster to a BSL pool and each EQL cluster to an SSL pool:

- **Level** = the cluster's extreme (`EqualLevel.price`) — the highest of the equal highs / lowest of the equal lows, because that edge is where the resting stops actually sit.
- **`intact`** = no _later swing_ has traded beyond the level. A later swing high above a BSL line triggered those stops; the pool is spent. This is structural bookkeeping from swings only — deliberately **not** sweep detection (no wick-through analysis, no reclaim semantics, no events).
- **`confidence`** (0–100) = a weighted blend of three normalized components, each exposed on the pool object so any consumer can answer "why this score" without re-deriving anything.

Pools are exposed on `SignalEvaluation.liquidity` (strongest first), drawn as dashed horizontal price lines on the token chart (purple BSL / cyan SSL, titled with confidence, intact pools only, own legend toggle), and fed to the AI analyst prompt.

## How confidence is calculated

`confidence = round(100 · (0.40·touches + 0.25·tightness + 0.35·recency))`

| Component   | Formula                                                                                      | Rationale                                                                                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `touches`   | `clamp01(0.5 + (n−2)·0.35)` → 2 touches = 0.5, 3 = 0.85, 4+ = 1                              | Every additional test of the level that _failed to break it_ leaves another layer of stops behind it. A double top is the baseline pattern, not the ceiling.                                                                                                      |
| `tightness` | `clamp01(1 − span/anchor/(2·tolerance))` → tick-identical = 1, at the tolerance envelope = 0 | The cleaner the level, the more precisely orders stack at one price rather than smearing across a band. Scaled by the same tolerance the cluster was detected with, so the score is meaningful at any tolerance setting (zero tolerance ⇒ all members exact ⇒ 1). |
| `recency`   | `(lastMemberIndex + 1) / swingCount`                                                         | Old pools decay: orders get repositioned, and the market that built the shelf is gone. Swing-indexed rather than wall-clock so the score is timeframe-agnostic and needs no candle data.                                                                          |

Weights: touches dominate (0.40) because stacked stops are the essence of a pool; recency (0.35) outweighs tightness (0.25) because a stale shelf, however clean, is less likely to still hold orders than a fresh, slightly ragged one.

## Why this approach

- **Derived, not detected.** The module adds no second detection pass and no state — it is a pure projection of `MarketStructure`. Determinism and replay safety are therefore _inherited_, not re-proven: the pool set at any historical point is a function of the swings that existed then (the prefix test in `liquidity.test.ts` pins `intact` flipping at exactly the swing that runs the stops, and cluster membership never changing retroactively).
- **Explainable by construction.** Every input is already on the cluster/structure objects (member count, member prices, swing positions); the components are exposed and the blend is a documented linear formula, round-trip-verified by test. There is no fitted model and nothing to drift.
- **Engine-only inputs, by requirement.** Volume, order-book depth, or funding data would all sharpen the score but live outside the structure layer; keeping the model structure-pure means every consumer of `SignalEvaluation` (backtest replays included) gets identical pools with no new data dependencies.

## Trade-offs accepted

- **Linear weights are a judgment, not a calibration.** No labeled outcome data exists yet to fit against; the weights encode trading reasoning and are trivially re-tunable in one place (`LIQUIDITY_WEIGHTS`). The shadow-record system could eventually supply outcome data to calibrate them.
- **Swing-indexed recency treats all gaps equally.** Ten quiet swings age a pool as much as ten violent ones. Time- or ATR-aware decay needs candles, which this layer deliberately does not take.
- **`intact` is binary and swing-based.** A wick above a BSL line that never confirms a swing leaves the pool "intact" even though some stops were likely taken — the honest answer requires candle-level sweep analysis, which is out of scope (below).
- **Confidence does not condition on trend context.** A BSL pool overhead in an uptrend (a magnet the trend is likely to reach) scores the same as one in a downtrend. Deliberate: trend interaction belongs to the consuming layer (intent/verdicts), not the level model.

## What was intentionally rejected

- **Liquidity sweep detection** (wick-through + reclaim + event emission) — explicitly deferred by the task. The `intact` flag was scoped to swing-level bookkeeping precisely so sweeps can later be layered on candles without touching this module's contract.
- **Retro-flagging or mutating pools** — a pool object's cluster membership and level never change once its swings complete, mirroring the EQH/EQL rule that a completed swing's record is immutable.
- **Filtering spent pools out of the engine output** — consumers get the full list with `intact: false`; only the chart filters. History is data.

## Risks

- The default 0.1% equality tolerance is tight for higher-timeframe majors (BTC 4H's nearest miss was 0.264% at implementation time), so pools will be rare there until tolerance is revisited — the pipeline is sound (loosening tolerance produces pools; verified), but users may see few lines initially.
- Confidence numbers may be read as probabilities. They are ordinal rankings; the UI shows them as bare scores deliberately.

## Validation performed

- 14 unit tests (`liquidity.test.ts`): BSL/SSL derivation through the real structure engine (never hand-built clusters), level = cluster extreme, empty cases, exact component values for touches/tightness/recency, confidence↔components round-trip against `LIQUIDITY_WEIGHTS`, intact/spent transitions on both sides, near-side rejections keeping pools intact, determinism, prefix replay-safety, strongest-first ordering, and `SignalEvaluation.liquidity` exposure.
- Full suite green (93 tests), lint and typecheck clean, production build succeeds.
- No existing behavior touched: structure/EQH/EQL code paths unmodified; `liquidity` is written into `SignalEvaluation` but read by no decision logic.

## Future extension points

1. **Liquidity sweeps** — candle-level wick-through-and-reclaim detection emitting events, consuming `LiquidityPool` as its target list. The natural next step and the reason `intact` is conservative.
2. **ATR- or timeframe-aware equality tolerance** — the single biggest lever for pool frequency on higher timeframes; the tolerance parameter already threads through both `computeMarketStructure` and `computeLiquidityPools`.
3. **Outcome-calibrated weights** — settle "did price reach the pool within N bars" via the shadow-record pattern and fit `LIQUIDITY_WEIGHTS` to data.
4. **Verdict integration** — intact pools between entry and target are magnets/obstacles the intent layer could cite in checklists and triggers ("BSL at $X overhead — a draw for longs, a trap for late shorts").
