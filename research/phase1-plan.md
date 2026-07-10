# Phase 1 implementation plan — objectives + POI entry (G3 + G8)

Source: `research/analysis.md` §9 (Phase 1), constrained by risks R2, R4, R5.

**Roadmap reorder (owner decision, 2026-07-10):** Phase 0.5 (the limit-fill /
no-fill harness extension) now runs **after** this phase's POI work, not before
it. The consequence is structural, not cosmetic: without the extended harness,
no shadow or expectancy claim about anticipatory limit entries is honest (R5),
so **Phase 1 inherits Phase 0's posture end to end** — everything lands as
derived views plus inert surfacing, validated on annotation fidelity against
the Dreimann fixtures. The two verdict-affecting deliverables §9 originally
assigned to this phase — the fallback-guarded **target cap** and the
**targets-required veto (G10)** — are _built, computed, and displayed_ here,
but consumed by no decision. They graduate in an explicit post-0.5 gate (see
"After this phase").

Scope contract for the whole phase:

- **No verdict impact.** No decision, score, veto, target, `SetupType`, or
  intent verdict changes. `RiskRewardPlan` is not modified — the POI-anchored
  plan is a _sibling_ read, never a replacement. The backtest/hysteresis/shadow
  keyspace is untouched (R2); the one shadow-schema change is an additive
  optional annotation field that keys nothing.
- **Derived views only.** New modules follow the `strength.ts` / `liquidity.ts`
  pattern: pure derivation over already-computed inputs, no state of their own,
  replay-safe by construction (bar-limited input in, what-was-knowable-then
  out). `structure.ts` is not edited.
- **Validation bar = annotation fidelity** on the Dreimann fixtures (objective
  prices, discount classification, stop ordering) — logic correctness only,
  never expectancy, never threshold tuning (R5 firewall). Rule choices are
  structural (orderings, edges, strict inequalities), not tuned constants.

**Prerequisite (blocking commit 1's fidelity tests):** `labels.json` is the
ground truth these tests are judged against and is still an open review item
from Phase 0 ("transcribed by Claude — check it against the PNGs"). The human
review must happen before any Phase 1 test outcome is treated as a verdict on
the algorithm. The objective prices/tolerances and the per-trade
`claimsWeakStructure` flags are exactly the fields this phase leans on.

Baseline before commit 1 (record in the PR description): `bun test` → **207
pass / 0 fail** (~26k assertions, 15 files) at `0c22d66`; lint/build clean.
Every commit keeps 207 + (new tests) passing with zero new failures.

Repo conventions: discretionary rule choices get an EDR in `docs/decisions/`
(next number: **0006**); doc comments explain the trading read, not the code.

---

## Commit 1 — `objectives.ts`: draw-on-liquidity resolver (G3)

**Responsibility:** answer "what is price drawn toward?" for a direction — as
a **ranked list of candidate objectives**, best first, with the top-ranked
candidate being the _preferred_ objective — and **absence (empty list) as a
first-class outcome** (the input to G10 later). Plus its EDR.

Returning the full ranked list rather than a single winner is deliberate
architecture: the current engine and UI consume only the preferred candidate,
but the alternatives are exactly what later phases need — a TP ladder
(Dreimann's TP1/TP2/TP3 are successive draws on the same path), Sanos's
"clear, obvious targets" plurality check, SMT pairing, and per-intent trigger
policies that may re-rank rather than re-resolve. This mirrors the
`computeLiquidityPools` precedent: a ranked array, consumers take the top,
nothing downstream breaks when a policy starts reading deeper.

**Files added:** `src/lib/engine/objectives.ts`,
`src/lib/engine/objectives.test.ts`,
`docs/decisions/0006-objective-draw-on-liquidity.md`.
**Files touched:** none.

**API (consumes only already-derived views — same dependency shape as
`equilibrium.ts`):**

```ts
export interface ObjectiveCandidate {
  direction: "long" | "short";
  /** The swing whose resting liquidity is the draw (weak high above / weak low below). */
  swing: SwingPoint;
  strength: SwingStrength; // per the EDR's eligibility rule
  /** The liquidity line: the coinciding intact pool's price when one exists, else the swing's. */
  price: number;
  /** Intact EQH/EQL pool coinciding with the swing, when the draw is a stacked-stops level. */
  pool: LiquidityPool | null;
}

/**
 * Ranked candidate objectives, best first — `[0]` is the preferred objective
 * (the engine/UI read); the rest are alternatives preserved for later
 * policies. Empty = no clean target, never fabricated.
 */
export function resolveObjectives(
  structure: MarketStructure,
  pools: LiquidityPool[],
  direction: "long" | "short",
  fromPrice: number,
): ObjectiveCandidate[];
```

**Rule (all choices recorded in EDR 0006 as initial, revisable):**

- Candidates: every eligible swing high strictly above `fromPrice` for a long
  (mirror for shorts). **Ranking = proximity, nearest first** — the draw is
  the first liquidity on the path, not the biggest — so the preferred
  objective is the nearest eligible draw and the tail is the ordered path
  beyond it. The EDR records proximity as the initial ranking key and names
  re-ranking (e.g. confirmation-mode preferring pool-backed candidates) as a
  policy question for later phases, answered by re-ranking this list, not by
  changing eligibility.
- **Eligibility:** strength `weak` qualifies outright ("objective = weak
  structure"); `unresolved` qualifies too — `strength.ts` defines it as
  "still targetable but unproven", and as-of a live bar the most recent
  opposing swing is usually unresolved (a weak-only rule would starve the
  resolver at exactly the bars that matter). `strong` never qualifies — a
  defended level is protection, not a draw.
- **Untaken only:** a candidate no later same-kind swing has traded strictly
  beyond (the `liquidity.ts` `intact` mirror, swing-level accounting) — taken
  liquidity is spent, whatever its strength label says.
- **Pool affinity:** when an intact opposing pool's line sits within
  `EQUAL_LEVEL_TOLERANCE` of the candidate swing (or between it and
  `fromPrice`), the candidate's `price` is the pool line — stops rest at the
  cluster extreme, not the single swing print. A pool absorbed into one
  candidate this way never spawns a second candidate of its own.
- **Empty list** when no candidate survives — never fabricated. Strict
  inequalities throughout, consistent with `structure.ts`/`strength.ts`.

- **Backward compat:** yes — new module, zero existing imports change.
- **Required tests:**
  - Unit: uptrend long → preferred (`[0]`) is the nearest untaken
    weak/unresolved high and the tail is strictly ordered by proximity with
    no duplicate levels; downtrend short mirror; taken candidates skipped;
    pool-affinity price promotion (and no double-count of an absorbed pool);
    empty when everything above is strong or taken; first-swing edge cases.
  - **Replay safety:** deterministic over identical input; prefix-window sweep
    (structure over growing pivot windows) shows the resolution at bar k uses
    only bars ≤ k — the ranking may legitimately _change_ as structure
    prints, but never from future data.
  - **Annotation fidelity (the phase bar):** per fixture, build the execution
    structure as-of the labeled entry time and resolve the long objectives;
    where `labels.json` sets `withinWindow: true` and `claimsWeakStructure:
true`, the **preferred** candidate's price must sit within the label's
    `tolerancePct` of the TP and its swing must derive weak/unresolved (the
    trader's TP matching a deeper-ranked candidate instead is a finding for
    the EDR — it means the ranking key, not eligibility, disagrees). Fixtures
    with `claimsWeakStructure: false` (zec-tp's already-recorded divergence:
    the engine reads that high strong as-of entry) assert the _documented_
    behavior from the EDR — a divergence is a finding to resolve or record,
    never a fixture edit.
- **Validation criteria:** suite green; diff shows only the three new files.
- **Expected output:** for the TRX fixture ("Objective hit weak structure"),
  `resolveObjectives(...)[0]` at entry time has a price within 1% of 0.33181
  with a non-strong swing behind it, and any higher untaken weak highs appear
  after it in rank order.

---

## Commit 2 — `poi.ts`: POI selection + the anticipatory limit plan (G8)

**Responsibility:** pick the POI a limit entry would rest at, and derive the
full anticipatory plan — **entry at the POI, stop beyond it, target at the
objective, RR measured from the limit price** (the R4 fix: `buildRiskPlan`
measures RR from `livePrice`, which is systematically wrong for Dreimann-style
entries). Plus its EDR.

In Phase 1 a POI **is** a `BaseZone` — the only POI type the engine has. The
OB/FVG/zone unification is Phase 3's job (per §9); this module's API takes
zones so Phase 3 can widen the input type without reshaping consumers.

**Files added:** `src/lib/engine/poi.ts`, `src/lib/engine/poi.test.ts`,
`docs/decisions/0007-poi-selection-and-limit-stop.md`.
**Files touched:** none.

**API:**

```ts
export interface AnticipatoryPlan {
  direction: "long" | "short";
  zone: BaseZone; // the POI the limit rests at
  entry: number; // proximal edge — where the limit fills first
  stop: number; // beyond the distal edge (see EDR)
  /** The preferred objective (`objectives[0]`): no objective → no plan (G10's shape). */
  objective: ObjectiveCandidate;
  riskPerUnit: number;
  rewardPerUnit: number;
  rewardRisk: number;
  /** Where the entry sits in the timeframe's dealing range; null when no range exists. */
  entryPosition: PricePosition | null;
}

export function selectPoi(
  zones: BaseZone[],
  direction: "long" | "short",
  fromPrice: number,
  range: DealingRange | null,
): BaseZone | null;

export function buildAnticipatoryPlan(
  zones: BaseZone[],
  direction: "long" | "short",
  fromPrice: number,
  range: DealingRange | null,
  /** Ranked candidates from `resolveObjectives`; the plan targets `[0]`. */
  objectives: ObjectiveCandidate[],
): AnticipatoryPlan | null;
```

Taking the ranked list (not a pre-plucked winner) keeps the seam where later
policies live: a confirmation-mode intent that prefers the nearest pool-backed
candidate, or a TP-ladder plan targeting `[0]`/`[1]`, changes only this
function's selection line, not the resolver or its consumers. Phase 1's rule
is simply "target the preferred candidate."

**Rules (EDR 0007 — the "POI selection when several qualify" needs-research
item from §7, settled as an initial deterministic choice, explicitly revisable
once the harness can measure alternatives):**

- Candidates: demand zones with proximal edge at/below `fromPrice` for a long
  (supply mirror). Selection order: **discount-side of the dealing range
  first** (a demand zone in premium is not the Dreimann entry), then
  **fresh over tested**, then **nearest proximal edge** — freshness beats
  depth because a consumed zone's limit is resting where orders already
  filled. When no dealing range exists, skip the position filter (absence of
  a range must not veto a plan that Phase 1 doesn't act on anyway) but record
  `entryPosition: null`.
- **Entry** = proximal edge (first price a resting limit fills at).
- **Stop** = beyond the **distal edge** — the zone's full wick extreme, which
  is precisely the ZEC-SL lesson: his stop sat _inside_ the POI's liquidity
  noise and was swept before TP. No ATR buffer constant — a tuned buffer is
  a threshold, and thresholds don't ship against these fixtures (R5). The
  EDR records "distal edge, no buffer" as the initial rule and names the
  buffer question as post-0.5 work (the harness is what can measure it).
- **Objective required:** empty candidate list → null plan. This is G10's
  shape ("no clean target → no trade") expressed as data; it vetoes nothing
  yet. The plan targets the **preferred** candidate (`objectives[0]`).
- **RR** = (objective.price − entry) / (entry − stop), long form; strictly
  positive geometry required (entry strictly between stop and objective),
  else null.

- **Backward compat:** yes — new module only.
- **Required tests:**
  - Unit: selection ordering (discount beats premium, fresh beats tested,
    near beats far); mirror for shorts; no-range behavior; degenerate
    geometry → null; RR arithmetic from the limit price, not `fromPrice`.
  - **Annotation fidelity:** zec-sl — the derived stop sits **at or below
    454.73** (the trader's stop that was swept; ours must be outside the
    noise that took his). All-fixture check: each labeled entry price falls
    inside or at the selected zone's band when a qualifying zone exists in
    the window; where none exists, the test records the absence (finding,
    not failure — 15m base zones are computed but `SD_ZONE_TIMEFRAMES`
    gates zones to 1H+; the fidelity test builds zones on the 4H context
    candles, which is where Dreimann draws his boxes anyway).
  - Replay safety: prefix-window determinism, as in commit 1.
- **Validation criteria:** suite green; only new files in the diff.
- **Expected output:** for a fixture with a fresh 4H demand zone under the
  entry, a plan whose entry is the zone's proximal edge, stop below its wick
  low, and target within tolerance of the labeled TP.

---

## Commit 3 — surface both reads on `SignalEvaluation` (additive, inert)

**Responsibility:** expose the objective and the anticipatory plan per
timeframe, read by nothing in the decision path — the exact Phase 0 commit-4
pattern.

**Files touched:** `src/lib/engine/quant.ts` + `instrumentation.test.ts` only.

Two sibling fields next to `swingStrength`/`dealingRange`, computed in
`evaluateSignal` from views it already derives (structure, pools, dealing
range) plus base zones computed locally for the evaluation's candles when the
timeframe qualifies (`SD_ZONE_TIMEFRAMES`); direction comes from the
evaluation's own `direction` (falling back to `lean`) and is `null`-safe:

```ts
/**
 * Ranked draw-on-liquidity candidates for the setup direction, preferred
 * first; empty = no clean target (Phase 1 instrumentation; read by no
 * decision). Engine/UI consume `[0]`; the tail is preserved for later
 * trigger policies (TP ladders, Sanos target plurality, SMT).
 */
objectives: ObjectiveCandidate[];
/** Limit-at-POI plan targeting `objectives[0]`: entry/stop/RR measured from the POI, not livePrice. Inert until Phase 0.5 grades it. */
anticipatoryPlan: AnticipatoryPlan | null;
```

- **Backward compat:** additive interface fields; `market.ts` inherits and
  ignores them. `strategyVersion` unchanged. Zones are currently computed in
  the token-page hook, not in `evaluateSignal` — computing them again inside
  the evaluation must stay behind the `SD_ZONE_TIMEFRAMES` gate and is the
  one non-trivial cost this commit adds; measure with the existing
  `replay-safe-benchmark.test.ts` pattern and keep the snapshot path's ~45s
  cache posture unchanged.
- **Required tests:** extend the Phase 0 inertness snapshots — every
  decision-bearing field of `evaluateSignal` deep-equal before/after over the
  mock-candle seeds; coherence (`anticipatoryPlan` null when `objectives` is
  empty, and its `objective` is identical to `objectives[0]` when present;
  every candidate's `direction` matches the evaluation's direction/lean;
  candidates strictly rank-ordered by proximity; plan RR positive when
  present).
- **Validation criteria:** inertness snapshots identical; diff touches only
  `quant.ts` + tests; build clean.

---

## Commit 4 — intent overlay, annotation-only + shadow tag

**Responsibility:** make the reads visible where decisions are explained —
checklist and summary in `assessIntent` — and tag shadow records so the
post-0.5 analysis can compare cohorts. **Verdict, sizeMultiplier, plan, and
triggers-to-act-on stay byte-identical.**

**Files touched:** `src/lib/engine/intent.ts`, `src/lib/engine/shadow.ts`,
their tests.

- `IntentAssessment` gains `anticipatoryPlan: AnticipatoryPlan | null`
  (the execution evaluation's plan, `scalePlan`-adjusted like `plan`) and the
  checklist gains two informational items when a direction exists:
  - **"Clean liquidity objective exists"** — done iff
    `execution.objectives.length > 0` (G10 displayed, not enforced). Detail
    names the preferred level and its strength, and notes how many further
    draws sit behind it.
  - **"Limit entry available at a POI in ctx discount"** — done iff the plan
    exists _and_ `classifyPrice(ctx.dealingRange, plan.entry)` is `discount`
    for longs / `premium` for shorts (Dreimann gates the POI against the
    **context** range; `entryPosition` on the plan is the execution-TF read).
- Shadow: `ShadowSignal` gains one additive optional field —
  `objectiveResolved?: boolean` — set in `buildShadowSignal` from the
  execution evaluation. It keys nothing (`setupType|regime` keying untouched),
  so histories stay comparable; it exists so Phase 0.5's analysis can ask "do
  favored calls without a clean objective underperform?" before G10 ever
  vetoes anything.
- **Required tests:** verdict-inertness over the intent test harness (verdict,
  sizeMultiplier, plan of every assessment unchanged with the overlay on);
  checklist items present/correct; shadow field round-trips and old records
  (field absent) still settle.
- **Validation criteria:** suite green; no verdict-bearing snapshot moved.

---

## Commit 5 (optional) — token-page surfacing of the anticipatory read

**Responsibility:** show the limit-at-POI plan as passive context next to the
existing plan — "If price pulls back: limit at X (fresh 4H demand, discount),
stop Y, objective Z (weak high), ~N R". Touches only `src/components/iq/` and
`src/routes/token.$symbol.tsx`; respects the glance-redesign plan-pinning and
read-strength invariants; renders nothing when the plan is null or the source
is demo data. Deferred without blocking the phase — exit criterion is met at
commit 4.

---

## Phase exit criteria

1. Commits 1–4 merged; suite green (207 + new, zero new failures).
2. `labels.json` human-reviewed (the Phase 0 open item), and the
   annotation-fidelity tests reproduce the objective prices and stop ordering
   on every fixture, with divergences documented in EDRs 0006/0007 rather
   than papered over.
3. Inertness + verdict-inertness regressions prove zero decision drift —
   Phase 1 makes **no** shadow or expectancy claim.
4. EDRs 0006/0007 record the resolver eligibility, pool-affinity, POI
   selection order, and stop rule as initial revisable choices.

## After this phase (queued, in order)

1. **Phase 0.5 — harness extension.** Limit-fill / no-fill outcome model over
   `AnticipatoryPlan` (fill = proximal-edge touch on closed bars,
   first-touch-decides; no-fill within the intent horizon is its own graded
   outcome, neither win nor loss) — likely a new walk in `tracker.ts` plus a
   `ShadowSignalStatus` extension, planned separately.
2. **Phase 1 graduation gate (needs 0.5).** Only now may the verdict-affecting
   pieces go live, measured per §9's gating: the objective as a
   fallback-guarded **cap** on `target1` with the R-multiple floor retained
   (R4), and **G10** as a real veto — first in shadow via the
   `objectiveResolved` cohort split, then live if the record supports it.

Order of operations is fixed (1 → 2 → 3 → 4): the objective resolver precedes
the POI plan because the plan requires an objective; both precede surfacing so
fidelity is proven before anything is displayed; the overlay lands last so its
inertness test has a stable engine underneath.
