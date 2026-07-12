# Pre-registered verdict protocol — engine 1.0.0 forward-test record

- **Status:** REGISTERED AND FROZEN 2026-07-12. No edits after the registration
  commit except appending the **Results** section verbatim at analysis time.
  Any flaw discovered in this protocol before the gate is handled by
  registering an amendment section _above_ Results (dated, with rationale),
  never by rewriting frozen text.
- **Registered by:** the roadmap's Phase 3 ("first verdict on the engine"),
  written _before_ the sample gate is reached, per `roadmap-2026-07-12`.
- **Registration record:** `backtest_run` row, `kind=verdict-protocol-1.0.0`,
  inserted at registration; the row's `note` carries this file's commit SHA.
- **Pattern:** follows `research/phase2-spike.md` / `phase3-spike.md`
  (hypothesis → frozen gates → verdict; insufficient evidence loses) and
  EDR 0011 (the record-semantics boundary).

---

## 0. Disclosure: what was known when this was written

Honest pre-registration requires stating the peek. At registration time the
author had seen `research/record-review-2026-07-12.md`: the first **37 settled
spot records** (engine 1.0.0, 18-symbol spot-only sampling frame, data through
2026-07-12 14:33 UTC+8) showing pooled 27.0% win rate [15.4–43.0%],
−0.24R ± 0.20 SE, 27% expiry, and `failed-breakout` cells trading poorly at
n≤4. **Every threshold below must therefore be justified independently of a
desired outcome, and the primary cohort excludes everything opened before the
registration boundary** — the analysis proper runs on data that did not exist
when this file was written. The n=37 peek cohort is retained only as a
declared, labeled secondary (§2c).

Registration-time integrity facts (counts only, verified 2026-07-12 ~10:30Z):
canonical volume restored (377 engine runs, 1 user, 55 shadow records, 0
mis-stamped provenance rows); worker on the 50-symbol dual-market build
(`evaluated=50spot+50perp`, ~27s passes); intents present: scalp, intraday,
swing (no `position`), so the longest settlement horizon is swing = 42×4H = 7
days (`INTENT_MAX_HOLD_BARS`, covered by `configHash` 04f8ad84).

## 1. Object under evaluation

The **shadow record** of engine `1.0.0` — every "favored" verdict the engine
adopts, entered at the adoption-time plan and settled by
`settleShadowSignal` (first-touch-wins on intrabar highs/lows, stop checked
before targets within a bar, expiry graded at the intent horizon's closing
price). This is the engine's public track record and the thing the product's
honesty rests on. Out of scope: the anticipatory fill-model record (own store,
own pre-registered graduation gate per EDR 0010 — 15 settled fills) and
tracked user follows (user-owned, not engine calls).

## 2. Cohorts

- **(a) PRIMARY — "registered spot cohort".** Shadow records with
  `engine_version = '1.0.0'`, `market = 'spot'`,
  `opened_at > 2026-07-12T11:00:00Z` (the registration boundary), settled, and
  **matured**: `opened_at ≤ analysis_time − horizon(intent) − 1h slack`, where
  horizon = `INTENT_MAX_HOLD_BARS[intent] × STEP_SECONDS[executionTimeframe]`
  (scalp 4h, intraday 24h, swing 7d). Maturation removes the snapshot bias
  where decisive outcomes (stop/target) settle early and would be
  over-represented among recent opens if still-active records were simply
  dropped. All decision rules in §7 read this cohort.
- **(b) REPLICATION — "perp cohort".** Same filters with `market = 'perp'`.
  Spot and perp verdicts for the same symbol at the same time are
  near-duplicates (same candles shape the read; funding/OI only modulates);
  pooling them would inflate effective sample size. Perp therefore carries
  **no primary decision weight**; it is a declared consistency check (§6).
- **(c) LEGACY PEEK — records opened before the boundary.** Reported for
  completeness, labeled, never pooled into (a).

## 3. Metrics

- **PRIMARY: mean settled R** ("expectancy") with a t-based 95% CI
  (`meanWithSe`, `mean ± t₀.₉₇₅,ₙ₋₁·SE`). R is `result_r` exactly as
  settlement wrote it — the R the engine's own grading semantics define.
- **Secondary (descriptive, no decision weight):** Wilson 95% win-rate
  interval; median R; expiry rate; target1/target2/stop distribution;
  per-intent means. Win rate deliberately carries no decision weight: R
  already integrates the payoff asymmetry, and two decision metrics invite
  fishing.
- **Sensitivity (reported alongside the primary, no independent decision
  weight):** mean R excluding expiries; mean R excluding the highest-count
  symbol (§6).

## 4. Expiries and active records

- **Expiries are wins/losses like any other settled record**, graded at their
  expiry-close R. Grounding: `settleShadowSignal` treats "went nowhere within
  the horizon" as a first-class graded outcome by design (its own doc
  comment); excluding expiries would bias the cohort toward decisive outcomes
  and overstate |expectancy|.
- **Expiry-rate tripwire:** if the primary cohort's expiry rate exceeds
  **40%** (registration-time observation: 27% on the peek cohort), the verdict
  gains an INVESTIGATE flag for horizon misfit (§7) regardless of the R
  result — a record dominated by expiries is measuring the hold windows more
  than the entries.
- **Active (unsettled) records:** never included; the maturation rule in §2
  guarantees their exclusion is outcome-independent.

## 5. Sample gate and thresholds

- **Gate: n ≥ 150 matured settled records in the PRIMARY cohort.** Basis: the
  peek cohort's R standard deviation ≈ 1.2; at n=150 the 95% CI halfwidth is
  ≈ ±0.20R, resolving expectancy at the granularity that matters (a ±0.2R
  bias is roughly the size the demotion machinery exists to catch). The gate
  is event-based, not calendar-based; the `--integrity` counter tracks
  progress without exposing outcomes.
- **Segment minimum:** any segment-level claim (§6) requires **n ≥ 30** in
  that segment (CI halfwidth ≈ ±0.45R — only gross failures are resolvable at
  segment level, and the criteria are sized accordingly).
- **Extension bound:** if the primary verdict is EXTEND (§7), the analysis
  re-runs once at **n ≥ 300**; at 300 the protocol terminates in a non-EXTEND
  verdict by construction (§7 rule 5).

## 6. Pooling, segmentation, multiplicity, robustness

- **Primary test is ONE test:** pooled mean R over the primary cohort. No
  correction needed.
- **Declared segment family** (Holm-Bonferroni at family-wise α = 0.05,
  m = 8): (1) scalp, (2) intraday, (3) swing, (4) `failed-breakout` pooled
  over regimes, (5) `pullback-continuation` pooled, (6)
  `higher-low-continuation` pooled, (7) `lower-high-rejection` pooled, (8)
  original-18 symbols vs extension-32 symbols (sampling-frame check the P2.1
  expansion owes us). Setup×regime cells are NOT in the family — the peek
  showed 12 cells at n≤8; cell-level tests at this n are noise. Anything not
  in this list is exploratory and may motivate a future spike but can trigger
  nothing here.
- **Perp consistency check:** at perp n ≥ 30, report perp pooled mean R and
  whether its 95% CI overlaps the primary's. Divergence (disjoint CIs) adds
  an INVESTIGATE flag (perp context integration misbehaving), never a CHANGE.
- **Robustness preconditions for any CHANGE verdict** (both must hold):
  - _Temporal stability:_ split the primary cohort at its median `opened_at`;
    both halves' pooled mean R must have the same sign as the full cohort's
    (mirrors phase3-spike Gate C — one bad market episode must not rewrite
    the engine).
  - _Symbol concentration:_ if any single symbol contributes >15% of the
    cohort, the triggering result must survive that symbol's exclusion.

  Failing either precondition downgrades CHANGE → INVESTIGATE.

## 7. Decision rules (exact, ordered; first match wins)

Let CI = the primary cohort's 95% CI on pooled mean R at the gate.

1. **CHANGE (global negative expectancy):** CI upper bound < 0, robustness
   (§6) holds → the engine as shipped loses money on its favored calls.
   Outcome: pre-registered spike (§9) targeting the decision layer; no
   interim hot-patch.
2. **CHANGE (concentrated failure):** CI contains 0 or is positive, AND some
   declared family segment (n ≥ 30) has a Holm-adjusted-significant negative
   mean R, AND excluding that segment moves the pooled point estimate up by
   ≥ 0.10R, AND the complement cohort's CI upper bound ≥ 0, AND robustness
   holds → the engine is sound except for an identified setup/intent class.
   Outcome: pre-registered spike scoped to that class only.
3. **INVESTIGATE:** any of — expiry rate > 40% (§4); perp divergence (§6); a
   family segment significant but failing the ≥0.10R-shift or complement
   condition; robustness failure downgrading a CHANGE. Outcome: a written
   investigation with its own pre-registered protocol; **no engine change,
   clock continues.**
4. **KEEP (positive expectancy):** CI lower bound > 0 → the record is
   evidence the favored gate earns its name. Outcome: clock continues;
   Phase 4 (record-aware product depth) unblocks with a defensible claim.
5. **EXTEND (indeterminate):** CI contains 0 and n < 300 → keep collecting to
   n ≥ 300, then re-run once. At n ≥ 300, CI still containing 0 resolves as
   **KEEP-WITHOUT-EDGE-CLAIM**: the engine is not demonstrably losing;
   the clock continues; the product must not present the record as evidence
   of positive edge, and further engine work is prioritized by product value,
   not by this record.

Verdicts 1–2 are the only paths to touching the engine. Verdict wording in
Results must quote the rule number matched.

## 8. Peeking policy

Between registration and the gate, the only permitted reads of the 1.0.0
record are: (a) `bun run record:report --integrity` (counts, provenance,
gate progress — no outcome aggregates; built at registration for exactly this
purpose), (b) worker/health monitoring (`?view=health`, journal logs), and
(c) whatever the product UI itself shows in normal use — the tracker page's
engine-record card exists for users and cannot be turned off for the author;
its pooled numbers are acknowledged as ambient exposure, but no ad-hoc SQL,
no full `record:report` run, and no new analysis against 1.0.0 until the
gate. The full report runs once at the gate and its output is committed
verbatim with the Results section.

## 9. On CHANGE: spike, version, clock

Any CHANGE verdict triggers, in order:

1. A **pre-registered spike document** under `research/` (hypothesis, frozen
   shared components, gates with numeric thresholds, the
   insufficient-evidence-loses asymmetry — the phase2/3-spike pattern).
   Implementation happens behind the frozen harness; no engine edit lands on
   `main` before the gate passes.
2. Results persisted via `record-backtest.ts` (`kind=<spike-name>`) and an
   EDR in `docs/decisions/`.
3. On adoption: **ENGINE_VERSION major bump** (decision/trigger semantics per
   `version.ts` semver intent), announced cohort boundary, clock restart —
   stats segment automatically by version; the 1.0.0 record is closed as a
   completed cohort, not deleted. Hold-coupling changes (EDR 0011 §rejected)
   ride the same bump if the spike touches the demotion statistic.
4. If the spike's gates fail, the CHANGE verdict resolves to the status quo
   ante (the engine stands; the record continues on 1.0.0) — a failed
   challenger is a kept incumbent, exactly as in the i.mss spike.

## 10. Known limitations (accepted at registration)

- **Stale `gitSha` (`556d39a`) on worker-stamped records** until
  `/etc/market-pulse-worker.env` is corrected — `engine_version` +
  `config_hash` (04f8ad84) are the GROUP BYs; gitSha is traceability only.
- **Cross-symbol correlation:** 50 symbols move with BTC; records are not
  independent draws. The temporal split-half and symbol-concentration guards
  (§6) are the mitigations; formal clustered inference is out of scope.
- **Sampling-frame era:** the primary cohort is entirely 50-symbol-era spot;
  conclusions describe engine 1.0.0 _as currently sampled_, not the 18-symbol
  era.
- **The 2026-07-12 orphan window** (~16:34–18:26 CST): the canonical record
  received no writes while the worker pointed at a fresh volume; settlement
  is kline-walk catch-up so no outcomes were lost, but open-cadence during
  the window is thinner. Entirely inside the legacy cohort; the primary
  boundary postdates the repair.

---

_Results section to be appended at the gate. Nothing above this line changes._
