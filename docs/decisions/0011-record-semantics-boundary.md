# EDR 0011: The record-semantics boundary — what changes require a version bump

- **Status:** Accepted (2026-07-12)
- **Scope:** Phase 2 (statistical power) of the 2026-07-12 roadmap. Classifies the two planned throughput/evidence changes against the `ENGINE_VERSION` discipline before any of them is built. Pinned by `src/lib/engine/record-boundary.test.ts`.
- **Depends on:** `evaluate.ts` (`evaluateSymbol` pipeline order), `shadow.ts` (`applyRecordAdjustment`, `buildShadowSignal`, `scalePlan` sizing-only contract), `hysteresis.ts` (`reconcileHolds`, `favoredBeforeAdjustment`, `VERDICT_RANK` upgrade rule).

## Problem

Phase 2 wants more evidence per unit time (bigger evaluated universe) and better
use of the evidence that exists (shrinkage/hierarchical combo estimates instead
of the flat n≥15 per-cell demotion). Both touch the machinery around the
forward-test record while the `1.0.0` clock is running, so each must be
classified: does it change _what gets recorded_, or only _what gets sampled /
how the record is read_?

## Proven boundary (2026-07-12, from code, pinned by test)

The pipeline is `assessIntents → applyRecordAdjustment(comboStats) →
reconcileHolds → openedFavored → buildShadowSignal`.

1. **The open gate reads the raw verdict.** `reconcileHolds` pushes into
   `openedFavored` on `entry.favoredBeforeAdjustment` — captured _before_ the
   demotion — so a demoted call still opens its shadow record. The record
   never self-censors its own evidence stream.
2. **Record content is demotion-independent.** The demotion branch rewrites
   verdict/headline/sizeMultiplier and halves the plan via `scalePlan`, which
   scales _sizing fields only_ (`positionSize`, dollar figures) — never
   entry/stop/targets. `buildShadowSignal` persists only
   prices/confidence/classification. The persisted row is byte-identical with
   or without the demotion.
3. **BUT the hold captures the post-demotion verdict.** A demoted adoption
   stores `verdict: "caution"` (rank 2) instead of `"favored"` (rank 3), and
   hold rank feeds the upgrade-release rule in `releaseReason`. A caution
   hold releases to a later favored read; a favored hold does not. So the
   demotion statistic shapes _when_ future holds release → the timing and
   count of future record opens.

## Classification

- **Universe expansion (worker evaluates more symbols): sampling-frame change,
  no version bump.** Per-symbol decision semantics are untouched; the change
  is _which_ symbols get evaluated. Caveat: combo stats pool across symbols by
  design, so new symbols' settled outcomes will move shared demotion cells —
  that is the _point_ (evidence accrues faster), and it operates through the
  same n≥15 rule that already governs. Mitigations: `engine_run.universe_json`
  records the evaluated set per pass, and every record carries its symbol, so
  cohorts remain separable post-hoc. The worker universe is a **superset** of
  the dashboard `UNIVERSE` — product surface unchanged.
- **Any change to the demotion statistic (shrinkage, hierarchical pooling,
  different thresholds): version-sensitive, requires a pre-registered spike +
  `ENGINE_VERSION` bump.** Even though the first-order gate and record content
  are clean (1, 2), the hold-rank coupling (3) means a different statistic
  changes open cadence — i.e., what the record contains over time. Shrinkage
  math may ship **read-only** (the record-review report, evidence notes) as
  long as nothing in `applyRecordAdjustment`'s demotion path consumes it.

## What was intentionally rejected

- **"Demotion is display-only, so stats changes are free."** False by (3) —
  disproven while classifying, which is exactly why this EDR exists.
- **Decoupling holds from the adjusted verdict** (capture the raw verdict in
  the hold to make the boundary fully clean). Rejected for now: it would
  itself change release timing — i.e., a version-bump change — and the current
  coupling is _intentional_ product behavior (a demoted read should not sit as
  a full-size favored hold). If a future spike adopts shrinkage, fixing the
  statistic and the coupling in one pre-registered change is the cheaper path.
