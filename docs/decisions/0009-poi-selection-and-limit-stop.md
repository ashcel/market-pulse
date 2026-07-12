# EDR 0009: POI selection + the anticipatory limit plan — discount/fresh/near, stop at the distal edge

- **Status:** Accepted, implemented (2026-07-10)
- **Scope:** `selectPoi` / `buildAnticipatoryPlan` in `src/lib/engine/poi.ts`. Phase 1 instrumentation: no verdict, score, or keyspace impact — the plan is a _sibling_ read next to `RiskRewardPlan`, never a replacement, and is consumed by no decision until the post-0.5 graduation gate.
- **Depends on:** `zones.ts` (POI = `BaseZone` in Phase 1), `equilibrium.ts` (EDR 0005) for the position filter, `objectives.ts` (EDR 0008) for the target; validated against the Dreimann ground-truth fixtures.

## Problem

The engine plans trades from the live price: `buildRiskPlan` measures entry, stop, and RR from `livePrice`, which systematically misprices a Dreimann-style anticipatory entry — a limit resting at a point of interest below the market (gap G8, risk R4). And "POI selection when several qualify" was an open needs-research item (analysis.md §7): the engine had no rule for _which_ zone the limit belongs at.

## The chosen rules

Each is an initial deterministic choice, explicitly revisable once the Phase 0.5 harness can measure alternatives — until then no expectancy claim exists to prefer one variant over another (R5).

### Selection (`selectPoi`)

Among zones of the entry kind whose proximal edge the pullback can reach (at/below `fromPrice` for longs; supply mirror), in order:

1. **Discount-side of the dealing range first** (premium for shorts) — a demand zone in premium is not the Dreimann entry; the framework buys discounts of the range. Judged at the zone's proximal edge with `classifyPrice`.
2. **Fresh over tested** — a consumed zone's limit rests where orders already filled; freshness beats depth deliberately.
3. **Nearest proximal edge** — the first POI the pullback reaches.
4. Earlier `startTime` as the total tie-break (determinism).

When no dealing range exists the position preference drops out entirely rather than vetoing — absence of a range must not kill a read Phase 1 doesn't act on anyway; the plan records `entryPosition: null`.

### Plan geometry (`buildAnticipatoryPlan`)

- **Entry = proximal edge** — the first price a resting limit fills at.
- **Stop = distal edge, no buffer** — the zone's full wick extreme. This is the ZEC-SL lesson made structural: the trader's stop (446.05) sat _inside_ the POI's liquidity noise and the Jul 7 04:00Z 4h bar wicked to 443.82, took it, then rallied through TP and objective alike. An ATR-style buffer beyond the edge was rejected: a tuned buffer is a threshold, and thresholds don't ship against seven charts (R5). Whether a buffer earns its keep is exactly what the 0.5 harness can measure — named here as post-0.5 work.
- **Target = the preferred objective (`objectives[0]`)**; the function takes the full ranked list so later policies (TP ladders, pool-preferring re-ranks) change one selection line, not the resolver or its consumers.
- **No objective → null plan** — G10's shape ("no clean target → no trade") expressed as data; it vetoes nothing yet.
- **RR from the limit price**: `(objective − entry) / (entry − stop)` long form, strictly positive geometry required (entry strictly between stop and objective), else null — a degenerate plan is no plan, not a clamped one.

## Replay properties

Pure derivation over already-computed views (zones, range, objectives), zero state — bar-limited window in, what-was-knowable-then out; pinned by prefix-window determinism tests. Every ordering has a total tie-break.

## What was intentionally rejected

- **RR from `fromPrice`/livePrice** — the R4 defect this module exists to fix.
- **Stop inside the zone or at the proximal edge** — re-creates the swept-stop failure the fixtures document.
- **ATR/percent buffer beyond the distal edge** — a tunable threshold; post-0.5 question.
- **Nearest-first above freshness/position** — depth-first selection parks the limit at the first pullback shelf regardless of whether it sits in premium or was already consumed; the framework's own ordering (discount, fresh) outranks proximity.
- **Vetoing the plan when no dealing range exists** — absence of one derived view must not silence another; recorded as `entryPosition: null` instead.

## Validation performed

- 20 tests: selection ordering (discount > premium, fresh > tested, near > far, reach filter, short mirror, no-range fallthrough); plan geometry (proximal entry / distal stop, RR from the limit not `fromPrice`, preferred-candidate targeting, null on no objective / no zone / degenerate geometry, `entryPosition` null-safety); determinism + prefix-window replay sweeps with strict stop < entry < objective ordering.
- **Annotation fidelity (logic correctness only, R5):**
  - **zec-sl (the phase bar):** the derived stop is **418.20 ≤ 454.73** — outside the liquidity noise that took the trader's stop (his 446.05 was swept by the 443.82 wick; ours would have survived it and the objective printed at 476.9+). Pinned by test.
  - **Per-fixture availability, recorded not asserted:** with zones built on the captured 4h context as-of entry — where Dreimann draws his boxes; `SD_ZONE_TIMEFRAMES` excludes 15m by design — zec-tp/zec-sl/ethfi-sl/trx-tp3 each have a qualifying demand zone below entry; jup-tp has none in the captured window (its POI predates it) and fet-tp's only zone is supply above — both surface as the documented null-plan path, a finding, not a failure.
  - **Observed divergence, recorded:** on zec-sl the selected zone ([418.2, 425.92], the deeper base) sits below the trader's chart POI box (~450): the zone detector finds the origin base, not the shallower re-accumulation his box marks. The consequence is conservative — a deeper limit and a stop outside the noise — but it means the _entry level_ read differs from the annotation. Whether the shallower POI is the better entry is unmeasurable before 0.5; revisit `computeBaseZones`' base criteria or POI typing (Phase 3's OB/FVG unification) then.
- Full suite green, lint clean.

## Future extension points

1. **Phase 0.5:** fill/no-fill grading over `AnticipatoryPlan` (proximal-edge touch on closed bars, first-touch-decides); the stop-buffer and shallower-POI questions become measurable there.
2. **Post-0.5 graduation:** target cap on `target1` (fallback-guarded, R-floor retained) and G10 as a real veto, per the phase plan.
3. **Phase 3:** widen the POI input type (OB/FVG/zone unification) without reshaping consumers.
