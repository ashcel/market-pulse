# EDR 0008: Objectives — ranked draw-on-liquidity candidates, absence first-class

- **Status:** Accepted, implemented (2026-07-10)
- **Scope:** `resolveObjectives` in `src/lib/engine/objectives.ts`. Phase 1 instrumentation (research/analysis.md §9, research/phase1-plan.md): no verdict, score, or keyspace impact — read by no decision until the post-0.5 graduation gate.
- **Depends on:** `strength.ts` (EDR 0004) for eligibility, `liquidity.ts` (EDR 0002) for pool affinity; validated against the Dreimann ground-truth fixtures.

## Problem

The engine's targets are R-multiples off the entry — geometry, not structure (gap G3). Dreimann's targets are _draws on liquidity_: the opposing weak swing whose resting stops the market is being pulled toward ("objective hit weak structure"), and a setup with no clean draw is not a trade at all (G10). Neither "what is price drawn toward?" nor "there is no clean target" is representable.

## The chosen rule

`resolveObjectives(structure, pools, direction, fromPrice)` returns a **ranked list** of candidates, **nearest first**; `[0]` is the preferred objective, the empty list is the no-clean-target outcome. Each choice below is initial and revisable — recorded here so a change is a documented decision, not drift.

- **Ranking = proximity to `fromPrice`.** The draw is the first liquidity on the path, not the biggest pool; the tail is the ordered path beyond it (a future TP ladder reads `[0]`, `[1]`, `[2]`…). Re-ranking for other intents (e.g. confirmation-mode preferring pool-backed candidates) is a _policy_ question for later phases, answered by re-ranking this list — never by changing eligibility.
- **Eligibility: `weak` and `unresolved`, never `strong`.** Weak is the literal framework read ("objective = weak structure"). Unresolved qualifies because `strength.ts` defines it as targetable-but-unproven, and as-of a live bar the most recent opposing swing is usually unresolved — a weak-only rule would starve the resolver at exactly the bars that matter (zec-sl's dotted objective is _unresolved_ at entry and settles weak later). Strong is a defended level: protection, not draw.
- **Untaken only.** A candidate no later same-kind swing has traded strictly beyond — the swing-level mirror of `liquidity.ts` `intact`. Taken liquidity is spent whatever its strength label says. Swing-level accounting deliberately; candle-wick truth stays in `detectLiquiditySweeps` (same separation as EDR 0004).
- **Pool affinity.** When an intact opposing pool's line coincides with a candidate — within `EQUAL_LEVEL_TOLERANCE` of the swing, or sitting between the swing and `fromPrice` — the candidate's `price` is promoted to the pool line: stops rest at the cluster extreme, not the single swing print. Each pool is absorbed into at most one candidate (nearest line wins), and duplicate price levels collapse into the pool-backed member (else the earlier swing), so one liquidity line never appears twice in the ranking.
- **Strict inequalities throughout** (`fromPrice`, taken-ness), consistent with `structure.ts`/`strength.ts`: a retest that matches is no break, a level at exactly `fromPrice` is no draw.

## Replay properties

Derived view over already-derived views (`deriveSwingStrength`, `computeLiquidityPools`), zero state — the same contract as EDR 0004/0005: bar-limited window in, what-was-knowable-then out. The _ranking_ may legitimately change as structure prints (a nearer swing appearing re-ranks the path); no candidate can ever derive from future bars. Deterministic: every sort has a total tie-break (price, pool-backed, swing time).

## What was intentionally rejected

- **Single-winner return.** Collapsing to one objective discards exactly what later phases need (TP ladders, Sanos target plurality, SMT pairing, per-intent re-ranking) and breaks the `computeLiquidityPools` precedent of ranked-list-consumers-take-the-top. See also the ranked-candidates API convention.
- **Weak-only eligibility.** Starves the resolver at live bars; see above.
- **Fabricating a target when the list is empty** (e.g. falling back to an R-multiple). Absence is the G10 signal; the R-multiple fallback belongs to the _cap_ graduation decision (post-0.5), not to this resolver.
- **Pool-first candidates** (pools spawning candidates without a qualifying swing). Pools already derive from swings; a pool whose swings are all strong or taken is not a draw this framework licenses.

## Validation performed

- 14 tests: proximity ranking with preferred-first and no duplicate levels; taken-candidate exclusion; short mirror; strong exclusion; strict `fromPrice` edge; empty-list outcome; pool promotion + single-absorption (including collapse preferring the pool-backed member), between-path pools, spent/wrong-side pools ignored; determinism and prefix-window replay sweeps over mock data.
- **Annotation fidelity (logic correctness only, R5):** on both weak-structure-claim trades the **preferred** candidate at entry time is the trader's TP level — trx-tp3: `[0]` within 1% of 0.33181, non-strong (the pullback's strong lower highs are skipped naturally); zec-sl: `[0]` within 1% of 476.9, the unresolved Jul 4 4h swing. The proximity ranking needed no correction to reproduce either.
- **Observed divergence, recorded not asserted (zec-tp):** as-of entry the engine types the 487-area high strong (its pullback broke the prior low), so the resolver offers _no_ candidate at the trader's TP — pinned by test as documented behavior. trades.txt makes no weak-structure claim for that trade; if Phase 0.5 grading later shows such levels resolving as draws, the eligibility rule is where to revisit.
- Full suite green, lint clean.

## Future extension points

1. **POI limit plan (Phase 1, EDR 0009):** consumes the ranked list, targets `[0]`, null plan on empty — G10's shape as data.
2. **Target cap + G10 veto (post-0.5 graduation):** objective as a fallback-guarded cap on `target1` keeping the R-floor (R4); veto measured first via the shadow `objectiveResolved` cohort split.
3. **TP ladders / Sanos plurality / SMT (P3–P4):** read deeper into the same list.
