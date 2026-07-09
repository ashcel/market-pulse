# EDR 0003: Liquidity sweeps — first penetration decides, on a single closed candle

- **Status:** Accepted, implemented (2026-07-09)
- **Scope:** `detectLiquiditySweeps` in `src/lib/engine/liquidity.ts`, `SignalEvaluation.liquiditySweeps` exposure, chart sweep markers, swept-pool filtering in presentation
- **Depends on:** EDR 0002 (liquidity pools). The `intact` flag was deliberately scoped to swing-level bookkeeping there so this feature could layer on candles without touching the pool contract — this EDR cashes that in.

## Problem

A liquidity pool tells you where stops rest; it cannot tell you what happened when price finally reached them. Two outcomes look identical at swing level but mean opposite things:

- **Sweep (stop hunt):** a wick trades through the level — triggering the stops — but the candle closes back on the near side. The raid trapped breakout traders and consumed the fuel; it frequently *starts* the move in the other direction.
- **Breakout (acceptance):** the candle closes beyond the level. The market accepted the new price; the level is simply gone.

EDR 0002 also documented a known gap: a raid wick that never confirms as a pivot leaves the pool `intact` by swing accounting even though its stops were taken. Sweep detection is the component that closes that gap.

## The chosen sweep definition

For each pool, scan closed candles **strictly after the pool's completing touch** (the cluster's last member bar — that bar's own extreme *is* the level and cannot sweep it). The **first candle whose wick penetrates the level (strict inequality; an exact touch is a test, not a raid) decides the outcome permanently**:

- close back on the near side (`close ≤ level` for BSL, `≥` for SSL) → **sweep event** emitted, with the wick extreme, the close, and penetration depth as a fraction of the level;
- close beyond the level → **breakout**, no event — and no later wick can sweep the pool, because the stops are already spent.

One pool ⇒ at most one sweep. Events are returned in time order with deterministic tie-breaks.

## Why this definition

- **Single closed candle matches the engine's epistemology.** Everything in this engine gates on closed bars (setup classification, trigger alerts, verdict settlement). A sweep that "completes" intra-bar doesn't exist until the bar closes; once it closes, the classification never changes.
- **First-penetration-decides is what makes the result append-only.** The first penetrating candle in any window remains the first in every extension of that window, so a sweep, once emitted, can never be un-emitted by later data — the strongest replay property available (pinned by test). Allowing later re-sweeps would require modeling stop *replenishment*, which is unknowable from price alone.
- **Derived, not stateful.** `detectLiquiditySweeps(pools, candles)` is a pure function of two deterministic inputs; like pools themselves, sweeps are recomputed per evaluation and inherit the pipeline's replay convention (replaying a window reproduces exactly what live computation over that window said).
- **Candle truth outranks swing bookkeeping, explicitly.** A sweep is reported even while the pool reads `intact` structurally, and the presentation treats a swept pool as spent (its line is removed, the analyst is told its stops are gone). The two lenses answer different questions — `intact` is "did any swing trade beyond," sweeps are "what did the first candle-level break mean" — and both are exposed.

## Trade-offs accepted

- **Multi-bar sweeps are not detected.** A close above the level followed by a close back below within a few bars — the "failed breakout" — is classified as a breakout here (no sweep event). That pattern is already captured elsewhere in the engine as the `failed-breakout` setup; folding it into sweeps would blur two definitions that trade differently. Cost: genuine two-bar raids are missed.
- **Scan start uses the touch bar's time, not its pivot-confirmation time.** Live, the pool isn't *known* until the completing touch confirms as a pivot (k bars later); a sweep in that gap is reported by replay but wasn't actionable in real time. This matches the established pivot-time convention used throughout the structure engine (labels, events, backtest windows) — consistency was chosen over introducing a second time-accounting scheme.
- **Sweeps are views, not persisted events.** If the still-forming leg or a growing cluster later reshapes a pool (rare, tolerance-edge cases), the recomputed sweep list reflects the new pool set. Window-in/window-out determinism holds; cross-window object permanence is not promised anywhere in this engine.
- **No sweep "strength" score yet.** Penetration depth and the pool's confidence are both exposed, so consumers can rank; a blended score was deferred until there's outcome data to justify weights (same reasoning as EDR 0002).

## What was intentionally rejected

- **Mutating `LiquidityPool`** (e.g. a `swept` flag) — pools' shape and behavior are untouched per requirements; sweeps reference pool objects instead, and consumers join by identity.
- **Wick-depth or volume thresholds** — a minimum penetration filter invites calibration debates with no data; strict inequality is the only unarguable line. Volume isn't available at this layer by design.
- **Emitting breakout events** — out of scope; breakouts are already a setup type in `quant.ts`, and duplicating the concept at two layers invites divergence.

## Validation performed

- 12 unit tests (extending `liquidity.test.ts`): BSL and SSL sweeps with exact extreme/close/penetration values; breakout-not-sweep including the no-later-sweep consequence; first-penetration-decides; exact-touch exclusion; completing-touch-bar exclusion; the intact-but-swept gap explicitly pinned; empty cases; cross-side time ordering; determinism; an append-only replay test over growing candle windows; and `SignalEvaluation.liquiditySweeps` exposure with pool identity (`evaluation.liquidity` contains every `sweep.pool`).
- Full suite green (105 tests), lint and typecheck clean, production build succeeds.
- Live-data scan across the tracked universe confirmed sweeps fire on real Binance klines and that swept pools drop out of the intact list fed to the chart and the AI analyst.

## Future extension points

1. **Multi-bar sweep windows** — treat a close-through reclaimed within N bars as a sweep variant, unifying with (or explicitly superseding) the `failed-breakout` setup. Needs a deliberate reconciliation of the two definitions first.
2. **Sweep-reaction confirmation** — a sweep followed by displacement away from the level (e.g. a CHoCH from the structure engine within a few swings) is the textbook reversal entry; the intent layer could consume `sweep + structure.event` as a compound trigger.
3. **Notification integration** — a sweep on a held verdict's symbol is exactly the kind of closed-candle event `triggers.ts` exists to push.
4. **Outcome-calibrated ranking** — settle "did price move ≥ X ATR away from the level within N bars of the sweep" via the shadow-record pattern, then score sweeps rather than just listing them.
