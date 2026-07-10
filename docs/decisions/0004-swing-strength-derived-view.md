# EDR 0004: Swing strength (strong/weak) — a leg-scoped derived view, never a stored field

- **Status:** Accepted, implemented (2026-07-10)
- **Scope:** `deriveSwingStrength` in `src/lib/engine/strength.ts`. Phase 0 instrumentation (research/analysis.md §9): no verdict, score, or keyspace impact.
- **Depends on:** the structure engine's alternating swing series (`structure.ts`); validated against the Dreimann ground-truth fixtures (`src/lib/engine/__fixtures__/dreimann/`).

## Problem

Objective selection in the Dreimann framework targets *weak structure*: "a swing that produced a BOS is strong (protected); one that failed to is weak (target)." The engine's swings carry HH/HL/LH/LL labels but no notion of proven vs. failed, so "objective = the opposing weak high" is unrepresentable (gap G2).

Strength is the engine's first *forward-looking* per-swing property — a high's type depends on what happens after it. Every existing per-swing field (`label`, `event`, `equal`) is backward-looking and frozen at swing completion, and `hysteresis`/`shadow` rely on that append-only record. Storing strength on `SwingPoint` would break that invariant (risk R1).

## The chosen rule (leg-scoped, first-verdict-decides)

For a swing at index `i` in the alternating series, with preceding opposite swing `swings[i-1]` and its own counter-leg `swings[i+1]`:

- **strong** the moment the counter-leg trades strictly beyond `swings[i-1]` — for a high, its pullback broke the prior swing low, making it the origin of a downward break of structure. Decidable mid-leg: a forming leg only grows more extreme, so a break cannot un-happen.
- **weak** once the counter-leg completes (`swings[i+2]` exists, freezing the leg's extreme) without that break. A failed leg cannot retroactively succeed.
- **unresolved** otherwise — no counter-leg yet, or forming without a break. This is precisely the state objectives are drawn from: targetable, unproven.

Strict inequalities throughout (an EQH/EQL retest is not a break), matching the HH/LL label rule. The first swing has no preceding opposite swing and stays permanently unresolved rather than faking a verdict. `judgedBy` exposes the counter-leg that delivered the verdict.

## Why this rule and not "any later break"

The first draft resolved a high **strong** if *any* later low broke the prior low before the high was taken. On the fixtures that over-grants strength badly: in a volatile range most highs eventually sit above some structural break and read strong — including highs whose own push down had already failed. A later break has its own origin swing; crediting it to an earlier high answers the wrong question. The leg-scoped rule is the literal reading of "produced a BOS / failed to", and it is what reproduced the trader's annotations (below). "Taken out" was also dropped as a *weakness trigger*: being taken confirms a weak high but is not what makes it weak — the failed counter-leg is, and that settles earlier and append-only.

## Replay properties

- **Derived view, zero stored state** (R1 Alt A): a pure function of `MarketStructure`, like `computeLiquidityPools`' `intact`. Bar-limited window in ⇒ what was knowable then, out.
- **Append-only under a stable pivot substrate** (pinned by test): within any window span where `pivotWindow(n)` is constant, a resolved strength never changes across growing windows. When `pivotWindow` steps (every 40 bars) the pivot set itself reshuffles — a pre-existing engine-wide property (EDR 0003: "cross-window object permanence is not promised"), not something this view can repair.
- `judgedBy` identity can be refined while the resolving leg is still the series' final, still-forming leg (its extreme pivot may be replaced by a deeper one); the strength *value* it delivered cannot change.

## Trade-offs accepted

- **Weakness waits one leg.** A high is not weak until the next high confirms its failed pullback — later than a trader eyeballing "no displacement" might call it, but the earliest closed-form moment that cannot flip.
- **First-swing agnosticism.** With no prior opposite swing, no verdict — consumers must tolerate `unresolved` at the series head and tail.
- **O(1) per swing** (only `i±1`, `i+2` are consulted), so the O(n) view is cheap to recompute per evaluation.

## What was intentionally rejected

- **Stored tri-state on `SwingPoint` + resolution events** — breaks append-only for that field and forces every consumer to handle transitions (R1 Alt B).
- **Any-later-break strength** — see above; empirically wrong against ground truth.
- **Candle-level (wick) breaks** — strength stays in swing space; candle truth already has its own lens (`detectLiquiditySweeps`), and mixing accounting schemes here would blur both.

## Validation performed

- 17 tests: identity/order of entries; strong mid-leg with `judgedBy`; weak-only-on-completion; uptrend (weak highs / strong lows) and downtrend mirror; equal-retest-is-no-break; last-two-swings-never-weak over mock data; append-only property over growing windows across 4 symbols, segmented by `pivotWindow` span.
- **Annotation fidelity on the Dreimann fixtures** (logic correctness only, R5): every trade shows a strong 4h low protecting below the entry as-of entry; both trades whose notes claim "objective hit weak structure" (trx-tp3, zec-sl) show the objective-level high targetable (non-strong) at entry and settled weak after being taken; zec-sl's dotted H4 objective is pinned to the exact 476.74 swing — unresolved at entry, weak once its leg completed.
- **Observed divergence, recorded not asserted:** zec-tp's TP sits under a high this rule types strong as-of entry; trades.txt makes no weak-structure claim for that trade (see labels.json).
- Full suite green, lint clean.

## Future extension points

1. **Objective resolver (Phase 1, G3):** nearest weak/unresolved high above (long) — this view plus `liquidity.ts` pools is its entire input.
2. **Dealing range (G4):** [last strong low, last strong high] bounds equilibrium; EDR 0005.
3. **Pro/Counter-Internal classification (Phase 2):** strength on the internal tier once the G1 spike resolves.
