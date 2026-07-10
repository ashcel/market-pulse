# EDR 0010: Anticipatory fill model — first-touch fills, never-filled carries no R

- **Status:** Accepted, implemented (2026-07-10)
- **Scope:** `anticipatory.ts` (`AnticipatorySignal`, `settleAnticipatorySignal`, `summarizeAnticipatoryRecord`) plus its store and settlement wiring. Phase 0.5 of the Dreimann/Sanos roadmap: measurement infrastructure only — no verdict, score, or keyspace impact. This record is what the Phase 1 graduation gate (target cap + G10 veto) reads before anything goes live.
- **Depends on:** `AnticipatoryPlan` (EDR 0009) as the graded object; `INTENT_MAX_HOLD_BARS` (hysteresis) as the horizon; `shadow.ts` as the comparison cohort's design template.

## Problem

The shadow record grades calls that enter at the live price — entry is assumed the moment the verdict is adopted. An anticipatory plan rests a limit _below_ the market (long form) and may never fill; grading it with the shadow's model would silently count unfilled limits as filled at adoption, which is exactly the dishonesty risk R5 forbids. Before any expectancy claim about anticipatory entries (the stop-buffer question, the shallower-POI question, the cap/veto graduation), fills must be modeled.

## The chosen rules

Each is a structural convention (orderings, inclusivity, horizons) — nothing tuned against data (R5).

- **Fill = first closed bar after adoption whose range touches the limit, inclusive** (`low ≤ entry` long / `high ≥ entry` short), first-touch-decides. Fills are modeled **at the limit price exactly** — a gap through the limit actually fills at a better price, so realized R is slightly understated, never overstated.
- **Pending horizon = `INTENT_MAX_HOLD_BARS[intent]` closed bars from adoption.** No touch within it → **`never-filled`**, a first-class outcome with **no `resultR`** — a limit that never filled produced no position, so it is neither win nor loss and is excluded from R statistics. It feeds `fillRate` instead (filled ÷ decided). A touch after the horizon does not count: the limit is treated as cancelled at horizon, matching how the verdict-hold layer ages reads out.
- **The fill bar is asymmetric: only the stop can resolve on it.** The bar was travelling into the limit; if it also traded through the stop, continuation is the plausible read → `stopped-out` at −1R (pessimistic, and precisely the zec-sl tape: one 4h bar filled 450.49 and swept 446.05). A same-bar _objective_ print gets no credit — the print may predate the fill's existence. From the next bar on, the walk is the `walkExitLevels` convention: stop checked before objective within each bar.
- **Position horizon = `INTENT_MAX_HOLD_BARS` from the fill bar** (not from adoption) — a filled anticipatory position gets the same hold window a shadow record does, keeping the two cohorts comparable. Neither level within it → `expired` at the last bar's close with R from that close (mirrors `settleShadowSignal`).
- **Records freeze at adoption** and are never updated to a moved plan — a resting limit stays where it was placed. One open record per symbol × market × intent (the shadow store's dedup rule); when it settles, the then-current plan opens the next record. Staleness between plan drift and record openings is accepted and measurable (the record stores the frozen entry).
- **Adoption happens at every verdict stage, and the verdict is stored.** A resting limit exists precisely while the trigger is unconfirmed — recording anticipation only on favored verdicts would erase the framework's actual use case. The `verdict` field lets the analysis split "anticipation during wait" from "anticipation during favored".
- **Separate store, never mixed into shadow combo stats.** `shadowComboStats` drives live verdict demotions (`applyRecordAdjustment`); anticipatory records live in their own persisted store (`iq-anticipatory-signals`) and are read by no decision (R2). `setupType`/`regime` are still recorded so cohort comparisons against the shadow record are possible offline.

## Re-entrancy contract

`settleAnticipatorySignal` is called repeatedly as bars close and must be append-only: a patch it issues can never be contradicted by a longer batch (a touch cannot un-happen; horizons complete once). Pending → `filled` (+`filledAt`) → terminal may collapse into a single pass when the batch already contains the whole story. A `filled` record resumes from `filledAt`; the fill-bar asymmetry re-applies only when the batch actually starts at the fill bar. Pinned by test.

## What was intentionally rejected

- **Grading anticipatory plans through `ShadowSignal`** (a status extension on the same store) — new statuses would flow into `summarizeShadowRecord`/`shadowComboStats`, which feed live demotions; filtering them back out puts decision-path code on the change surface for a measurement feature. A sibling store keeps R2 airtight. (The phase plan's sketch said "a `ShadowSignalStatus` extension"; this is the deliberate deviation from it, for that reason.)
- **`resultR: 0` for never-filled** — zero is a claim ("break-even") that pollutes averages; absence is the honest encoding.
- **Objective credit on the fill bar** — intrabar sequence is unknowable; crediting it would systematically flatter the model on wide bars, the opposite of the walk's pessimistic convention.
- **Fill at the bar's open on gap-through** — more accurate but adds a price-improvement model; at-limit is the conservative floor and keeps R comparable to the plan's frozen `rewardRisk`.
- **Cancel-on-plan-change** (a fourth outcome) — couples the record to evaluation cadence; frozen-at-adoption with one-open-per-intent is simpler and the drift is measurable after the fact.

## Validation performed

- 17 tests: resting/never-filled horizon (no R), inclusive touch, forming-bar exclusion, post-horizon fill rejected, single-pass fill+outcome, fill-bar stop sweep (−1R), fill-bar objective no-credit with next-bar credit, stop-before-objective ordering, expiry R from close, open-position null, short mirror, append-only under growing batches, build/summarize contracts.
- **Dreimann zec-sl through the model:** the trader's actual plan (450.49 / 446.05 / 476.9) settles `stopped-out` at −1R with fill and stop on the same 04:00Z 4h bar — the harness reproduces the recorded loss exactly. The identical entry with a stop outside the sweep's 443.82 extreme (the EDR 0009 distal-edge rule) settles `objective-hit` at >3R — "would have reached TP without stop", now a graded quantity instead of a chart annotation.
- Full suite green, lint/build clean.

## Future extension points

1. **Phase 1 graduation gate:** read this record (fill rate, filled-cohort expectancy, `objectiveResolved` split on the shadow side) to decide the target cap and G10 veto.
2. **Stop-buffer question (EDR 0009):** compare stopped-out-on-fill-bar frequency across stop variants offline — the harness makes the alternative measurable without shipping a threshold.
3. **Shallower-POI question (EDR 0009):** fill rate is exactly the metric that arbitrates deep-origin vs shallow re-accumulation zones.
