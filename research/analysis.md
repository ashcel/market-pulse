# Dreimann × Sanos vs. the Market-Pulse engine — methodology study

Status: research note, 2026-07-10. No code changes proposed here — this is the
map we build implementation tickets from.

---

## 1. What each methodology actually is

The two sources are **not the same kind of thing** and must be modeled
separately before deciding when to combine them.

### Dreimann — a top-down multi-timeframe *framework*

Evidence: `research/dreimann/trades.txt` + the 7 TradingView screenshots
(15m/1h/4h crypto perps). Vocabulary: *Pro Swing, Pro Internal, Counter
Internal, objective, weak structure, POI, i.mss, liquidity left/right,
premium/discount.* This is the ICT-derived "swing → internal" school
(TTrades/Daye lineage).

The decision loop, reconstructed from the notes and charts:

1. **Read HTF swing structure** (H4) → directional bias.
2. **Name the objective** = the *opposing weak high / weak low* price is drawn
   toward. "Objective hit weak structure H4" appears verbatim. The target is a
   **liquidity draw**, not a fixed R multiple.
3. **Locate a POI** (order block / demand-supply / FVG) sitting in **discount**
   (for longs) that is aligned with the swing. "POI expected to be respected."
4. **Wait for internal alignment** — the `i.mss` label = an *internal* market
   structure shift on the execution TF (M15) confirming internal has flipped to
   agree with the swing. "M15 sudah shifting bullish untuk alignment dengan H4."
5. **Enter** — usually a **limit at the POI** (anticipatory), sometimes market
   after the shift.
6. **Risk** — SL beyond the POI/swing, TP at the objective. RR clusters ~3R.

**Trade taxonomy (the core classifier):**

| Label | Meaning | Read |
|---|---|---|
| Pro Swing + Pro Internal | with HTF swing *and* current internal | A+ (TRX TP3) |
| Pro Swing + Counter Internal | with HTF swing, *against* live internal — betting the internal flips back | higher risk (ETHFI → SL) |
| Counter Swing | against HTF swing | rarely taken |

The example trades all share one shape: **anticipatory limit entry into a POI
in discount, after an HTF pullback, targeting opposing liquidity (a weak
high).** ZEC/JUP/FET/HYPE are all "play the HTF swing pullback." The two losses
are instructive:
- **ETHFI (SL):** *Counter Internal* — with swing but against internal. The
  framework itself flags this as lower-probability.
- **ZEC (SL, "would have reached TP without stop"):** POI was respected but the
  stop sat *inside* the POI's liquidity noise. Lesson: **stop placement is
  relative to the POI + resting liquidity, not a fixed distance.**

### Sanos — a bottom-up mechanical *entry trigger* (iFVG model)

Evidence: `research/sanos/Sanos Setup.pdf`. Very low timeframes (30s–5m,
NQ-flavored). A **hard, all-required checklist** — this is an execution trigger,
not a framework:

1. **Liquidity sweep** — a 5m swing high/low that *previously rejected from an
   FVG* gets swept. Don't drop below 5m for the sweep (lower TF = lower prob).
2. **Delivery** — price is *delivering out of an FVG* (iFVG inversion) on a
   matching or nearby TF. **No delivery from ≥1 TF → no trade.**
3. **FVG size** — gap ≥ a minimum (his: 9 points absolute). A volatility filter.
4. **Targets** — must have clear, obvious liquidity targets (trendline
   liquidity, equal highs/lows, intermediate-term H/L) **and** a break-even
   spot. **No clean target → no trade.**
5. **Bonus (optional, never required):** SMT divergence and/or being in HTF
   **premium/discount**.

Sanos buys its claimed 85% by being ruthlessly selective on 4 mechanical gates.

### The key distinction

**Dreimann answers *where* and *why* (context, POI, objective). Sanos answers
*when* (precision trigger inside a zone).** Sanos's "bonus" tier
(premium/discount + SMT) *is* Dreimann's context. They nest naturally — but only
under conditions in §4.

---

## 2. Explicit rules vs. inferred assumptions

Separating what is stated from what we're reading into the charts matters,
because only the explicit rules can be encoded with confidence; the inferred
ones are the "needs research" pile.

### Dreimann — explicit
- Trade is classified against **two structure tiers** (swing + internal).
- Objective = **weak structure** (a high/low expected to be taken).
- Entry is anchored to a **POI**; entry types are Limit or Market.
- `i.mss` (internal MSS) is the alignment/confirmation event.
- Fixed-ish **~3R** targeting.
- Long in **discount** (premium/discount referenced).

### Dreimann — inferred (assumptions, flag before coding)
- **Which TF pair defines swing vs internal.** The notes map swing=H4,
  internal=M15 (cross-timeframe), *not* two pivot scales on one chart. This
  directly bears on our prior decision — see §5.
- **How a POI is chosen** when several exist (freshness? nearest to discount
  50%? origin of the displacement leg?). Charts show order-block-shaped boxes;
  exact selection rule is not stated.
- **What makes a high "weak" vs "strong."** Standard SMC: a swing that produced
  a BOS is *strong* (protected); one that failed to is *weak* (target). Assumed,
  not written.
- **Stop rule** — the ZEC loss implies "beyond POI + its liquidity," but no
  explicit formula.

### Sanos — explicit
- 5m sweep of a swing that previously rejected an FVG.
- Delivery required from ≥1 TF; matching-TF preferred.
- FVG ≥ 9 points.
- Clear targets + BE spot required.
- SMT / premium-discount are bonus, not required.

### Sanos — inferred
- **"Delivering from an FVG"** needs a precise closed-bar definition (trade
  into the gap, then displace away) to be replay-safe.
- **"Previously rejected from an FVG"** — how far back, what counts as a
  rejection.
- **9 points** is instrument-specific; the portable form is ATR% or range%.
- **"Clear, obvious target"** is exactly our liquidity-pool map — encodable, but
  the *threshold* for "obvious" is discretionary.

---

## 3. Gap analysis vs. the current engine

The engine today (per `structure.ts`, `liquidity.ts`, `zones.ts`, `location.ts`,
`quant.ts`, `intent.ts`) already has a strong SMC spine:

**Present:** swing structure HH/HL/LH/LL + BOS/CHoCH + trend; EQH/EQL → liquidity
pools with confidence + intact; liquidity **sweeps** (wick-through + close-back,
first-touch-decides, replay-safe); supply/demand **base zones** (freshness); a
**location** grade (support→resistance position + zone/session confluence); fixed
**MTF intent pairs** (scalp 1H/15M … position 1W/1D) with verdicts, counter-trend
sizing, an HTF-liquidity overlay and a perp-funding overlay; hysteresis, shadow
record, per setup×regime backtest.

That is roughly the *left half* of Dreimann and the *targets* half of Sanos. The
gaps:

| # | Missing concept | Source | Present today? | Why it matters |
|---|---|---|---|---|
| G1 | **Internal vs swing structure (2 tiers)** | Dreimann core | No — one alternating series | The entire Pro/Counter-Internal classifier is unrepresentable |
| G2 | **Strong vs weak highs/lows** | Dreimann + Sanos targets | No — only HH/HL/LH/LL | Objective selection + "protected" swings depend on it |
| G3 | **Draw-on-liquidity / objective targets** | Dreimann | No — targets are `max(resistance, entry+1.8R)` and `+3R` | Targets aren't anchored to real liquidity |
| G4 | **Premium / Discount (equilibrium)** | Both | No equilibrium concept at all | Can't gate "long only in discount" |
| G5 | **FVG detection** | Sanos required, Dreimann implied | No | Foundation for iFVG + displacement |
| G6 | **iFVG (inversion) + delivery** | Sanos core | No | Sanos's whole trigger |
| G7 | **FVG size filter (normalized)** | Sanos | No | The selectivity gate |
| G8 | **POI as limit-entry anchor** | Dreimann | Partial — base zones exist, entries anchor to livePrice | No anticipatory limit-at-POI |
| G9 | **MSS-as-trigger, separable from BOS** | Dreimann | Partial — folded into `setupType`/decision | Can't express "wait for internal shift at POI" |
| G10 | **Targets-required veto** | Sanos | No — engine always emits a target | "No clean target → no trade" not enforced |
| G11 | **SMT divergence** | Both (bonus) | No (but `market.ts` universe + BTC make it feasible) | Optional confidence booster |

The single highest-leverage gap is **G1+G2 together** (nested structure with
typed strong/weak swings), because G3 (objectives) and G9 (MSS trigger) fall out
of it almost for free.

---

## 4. When to combine — and when not

**Combine (the nested model):** Dreimann selects the arena (HTF bias, POI in
discount, objective = weak high); Sanos supplies the trigger inside the POI
(sweep + iFVG delivery + size). The objective doubles as Sanos's required
"clear target," and Dreimann's premium/discount *is* Sanos's bonus tier. Best
when you want a **mechanical entry inside a discretionary HTF bias** and both
agree on direction.

**Do NOT combine when:**

1. **TF / instrument scale mismatch.** Sanos's 9-point FVG and 30s–5m delivery
   are NQ-intraday. Grafting them onto Dreimann's H4/M15 crypto *swing* changes
   the holding period and the population of trades. Renormalize (ATR%/range%)
   and keep the sweep TF within one step of the execution TF, or don't graft.
2. **Anticipation vs confirmation conflict.** Dreimann's edge is often the
   **anticipatory limit** at a POI ("expected to be respected"). Sanos is
   **confirmation-only** ("no delivery → no trade"). These are two points on one
   spectrum. Requiring Sanos confirmation on every Dreimann limit suppresses a
   real slice of Dreimann's setups; taking Dreimann limits *without* a trigger
   is exactly the lower-probability entry Sanos filters. **Choose per intent
   (anticipation for swing/position, confirmation for scalp/intraday) — do not
   average the two into one entry rule.**
3. **Target philosophy.** Sanos scalps to nearest clean liquidity; Dreimann
   holds to the HTF objective. Mixing target selection yields incoherent RR.

Practical mapping onto our intent ladder: **swing/position → Dreimann-weighted
(limit at POI, HTF objective). scalp/intraday → Sanos-weighted (require trigger,
nearest-liquidity target).** The two overlays already in `intent.ts` (HTF
liquidity, perp funding) are the right precedent for how these attach.

---

## 5. Architecture: the modeling smell, and a better core

The current engine models each timeframe as **one alternating swing series → one
trend/lean → one flat `setupType` enum**, then bolts MTF together by pairing
fixed timeframes in `intent.ts`. `SetupType` (`breakout | failed-breakout | …`)
**conflates trigger + location + direction into a single label**. That is why
FVG, order blocks, premium/discount, and objectives have nowhere to live — the
type system has no slot for them.

**Proposed core abstraction (compositional, not enum):**

```
Setup = Bias × POI × Trigger × Objective
```

1. **StructureModel (per TF)** maintaining **two nested tiers** — swing and
   internal — each swing point typed **strong/weak** (did it produce a BOS?).
   Subsumes BOS/CHoCH/MSS at each tier. Solves G1, G2, G9.
2. **DrawOnLiquidity / Objective resolver** — given swing bias + the pool /
   weak-structure map, what is price drawn toward? Replaces R-multiple targets
   with liquidity objectives. Solves G3, G10.
3. **POI abstraction** unifying order block, FVG, and base zone — each carrying
   its **premium/discount position** and freshness. Solves G4, G5, G8.
4. **Trigger layer** (MSS / iFVG-delivery / sweep) **separable from the POI**, so
   anticipation vs confirmation is a *policy choice per intent*, not baked in.
   Solves G6, G9, and the §4.2 conflict cleanly.

`setupType` then becomes a *derived description* of a composed setup, not the
primary model.

**But this is the target, not the next step — see Risk R2.** A full remodel churns
the backtest/hysteresis/shadow keyspace, so the near-term move is to attach these
concepts as **orthogonal overlays** (the pattern `intent.ts` already uses for the
HTF-liquidity and perp-funding reads) and promote to a real remodel only if the
overlays visibly strain.

### Tension to resolve first (ties to a prior decision)

Memory `internal-external-structure-deferred` records that **intra-timeframe
second-pivot scale was rejected on 2026-07-09**, because context/execution TF
pairing already supplies "external" structure. His swing=H4 / internal=M15 *looks*
cross-TF — but Dreimann draws **both tiers on the same execution chart** and the
`i.mss` trigger fires on M15, which requires both tiers in one pivot space. **Two
independent per-TF structure computations are an approximation of nested structure,
not an equivalent** (a 4H swing low may correspond to no M15 pivot), and the
rejection was made for supplying *external context*, not an *internal trigger* —
a different requirement. **So G1's tier mechanism is unresolved (see Risk R3): run
a spike before committing to cross-TF.** What *is* safe: **G2 (strong/weak typing)
and G4 (equilibrium) are tier-mechanism-agnostic** — build those first; they don't
depend on how the tension resolves.

---

## 6. Deterministic-algorithm sketches (for backtesting)

All must be **closed-bar and replay-safe**, matching the existing engine's
discipline (see `liquidity.ts` first-touch-decides).

- **Strong/weak swing typing (G2):** a swing high is **strong** iff a later
  swing low broke the prior swing low *after* it (i.e., it is the origin of a
  BOS leg); else **weak** (and **unresolved** until a break settles it). Mirror
  for lows. **This is forward-looking, so it must NOT be a stored `SwingPoint`
  field** — that would break the engine's frozen-record invariant (see Risk R1).
  Compute it as a **derived view** the way `liquidity.ts` derives `intact` by
  scanning forward: a `strength.ts` module over a bar-limited structure, which
  is replay-safe by construction.
- **Equilibrium / premium-discount (G4):** for the active dealing range
  [lastStrongLow, lastStrongHigh], `eq = (hi+lo)/2`; price > eq = premium,
  < eq = discount. One float + a comparison. Gates direction. **Depends on G2**
  (the range is bounded by *strong* swings), so sequence strength → range →
  premium/discount. The dealing-range definition itself is a discretionary
  choice — see needs-research.
- **FVG (G5):** 3-candle imbalance — bullish when `low[i] > high[i-2]`; the gap
  is `[high[i-2], low[i]]`. Size normalized as `gap / price` (%) or `gap / ATR`.
- **iFVG + delivery (G6):** track FVGs; mark **inverted** when a close crosses
  fully through the gap; **delivery** = price returns into the inverted gap and
  the next closed bar displaces away from it. Emit once (first-touch-decides).
- **Objective / draw-on-liquidity (G3):** nearest **weak** high above (long) /
  weak low below (short), preferring intact liquidity pools (reuse
  `liquidity.ts`). **Ship as a guarded cap/annotation on the existing target,
  keeping the R-multiple floor as fallback** — a raw objective can be sub-1R or
  absent (see Risk R4). RR must be measured from the **POI-anchored entry (G8)**,
  not `livePrice`, so G3 and G8 land together.
- **Internal MSS trigger (G9):** on the execution TF, a CHoCH of the *internal*
  tier in the swing's direction, occurring while price is inside a POI. This is
  the confirmation gate for confirmation-mode intents.

These slot into the existing `evaluateSignal` → `assessIntent` pipeline. **The
shadow/backtest harness must first be extended with a limit-fill / no-fill
outcome model (see Risk R5) before it can honestly grade anticipatory setups.**

---

## 7. Needs-research (do not implement blind)

- **Internal-tier definition** — confirm cross-TF (recommended, §5) vs a
  principled intra-TF prominence ratio. Revisits a settled decision; get sign-off.
- **POI selection rule** when several qualify (freshness vs discount-depth vs
  displacement-origin). Dreimann doesn't state it; needs labeling of the example
  charts to fit.
- **"Delivery" formalization** — the exact closed-bar rule for
  delivering-from-an-FVG. Prototype on the Sanos screenshots.
- **FVG size threshold** in normalized units — needs a sweep over ATR%/range%
  against outcomes, not a ported constant.
- **SMT (G11)** — correlation basket + swing-timing alignment across assets;
  data + pairing design.
- **The 85% claim** — selection/survivorship. Validate through the shadow record;
  never trust the headline.
- **G1 tier mechanism** — cross-TF vs single-chart nested-prominence vs a hybrid
  that re-projects context-TF swings onto the execution series. Resolve by spike
  (Risk R3), not by inheriting the 2026-07-09 decision.

---

## 8. Architectural risks & alternatives

Written before committing to Phase 0. Ordered by how directly each threatens the
near-term work. `Rn` are referenced from §5–§7.

### R1 — Strong/weak typing breaks the frozen-record invariant *(hits Phase 0)*

`structure.ts` guarantees every per-swing field (`label`, `event`, `equal`) is
**backward-looking and frozen** — `hysteresis` and `shadow` depend on that
append-only property. Strong/weak is the **first forward-looking property**: a
high is weak until a later low breaks structure, then strong. Its value is a
function of how much history you've seen, so it *cannot* be frozen at
swing-completion. My original §6 sketch ("compute in a fold and freeze") was
wrong.

- **Alt A (chosen):** derived view, not a stored field — a `strength.ts` module
  that scans forward at read time, exactly like `liquidity.ts` derives `intact`.
  Replay-safe by construction (pass a bar-limited structure).
- Alt B: stored tri-state `strong | weak | pending` + a resolution event. Breaks
  append-only for that field; forces consumers to handle transitions. Rejected.

### R2 — The compositional remodel churns the backtest/hysteresis/shadow keyspace

`SetupType` is not just a label — it **keys** `runBacktest` (setup×regime), the
hysteresis demotion records, and the shadow schema. Remodeling the taxonomy
**invalidates accumulated shadow/hysteresis history**. "Derived description"
was underspecified — without a stable mapping it still churns keys.

- **Alt A (chosen):** attach new SMC dimensions as **orthogonal overlays** (the
  `intent.ts` HTF-liquidity / perp-funding pattern) — zero keyspace churn.
  Promote to a real remodel only if overlay interactions get unwieldy.
- Alt B: full remodel behind a versioned key namespace so histories coexist.
  Higher cost; defer.

### R3 — Cross-TF is an *approximation* of nested structure, not an equivalent

Dreimann draws swing + internal on one chart; the `i.mss` trigger needs both
tiers in one pivot space. Two independent per-TF computations can't guarantee a
context-TF swing maps to any execution-TF pivot. And the 2026-07-09 rejection
answered a different question (external context, not an internal trigger), so
inheriting it here risks a category error.

- **Alt A:** single-chart nested pivots at two prominences — reopen the rejection
  on its merits *for this use*.
- Alt B: cross-TF but re-project context swings onto the execution series (snap to
  nearest pivot) so both tiers share one space.
- **Chosen for now:** treat as a **spike** — test on the 7 charts whether
  context-TF structure reproduces the swing pivots Dreimann drew *before* picking.

### R4 — Objectives are coupled to POI entry, lose the RR floor, and starve samples

`max(resistance, entry+1.8R)` / `+3R` guarantees a minimum RR and always exists.
Raw "nearest weak high / pool" can be 0.3R away (a trade the floor blocks) or
**absent** (→ veto → fewer trades → risk of dropping below
`MIN_RELIABLE_BACKTEST_TRADES`). And Dreimann's RR is measured from a **limit at
the POI**, not `livePrice`; computing it from the close (as `buildRiskPlan` does)
is systematically wrong. So **G3 can't be validated without G8.**

- **Alt A (chosen):** ship the objective as a **fallback-guarded cap** on the
  existing target, preserving the floor; **merge G3 + G8** into one phase so RR
  is measured from the right entry.

### R5 — The harness *and* the ground truth are inadequate for the new signals

Two measurement-validity holes behind the "shadow-gated" claim:
- **Fill model:** the shadow record settles favored calls assuming (effectively)
  a market entry. Dreimann setups are **limit entries that may never fill** —
  no-fill is neither win nor loss. The harness has no such outcome, so shadow
  numbers for anticipatory setups aren't comparable to the live engine's.
- **Ground truth:** the 7 charts are **5 TP / 2 SL, all bullish swing-pullback
  longs, one trader, one window.** Tuning any threshold to them overfits one
  archetype; there is zero coverage of shorts or true no-trades.

- **Mitigations (adopted):** extend the harness with a **limit-fill / no-fill
  outcome** before any phase that emits limit entries; **firewall the 7 charts to
  logic-correctness only** (do we label the same pivots/FVGs?), never threshold
  tuning; tune against a broader self-labeled set including shorts and no-trades.

---

## 9. Roadmap (correctness-first, incremental) — revised

Reflects §8. Two ideas replace the old plan: **strength is a derived view**, and
**Phase 0 is instrumentation validated against chart annotations, not a
verdict-affecting change validated in shadow.**

- **Phase 0 — Instrumentation (no verdict impact, no shadow claim).**
  Strength typing (G2) as a **derived `strength.ts` module** (R1), then dealing
  range → equilibrium/premium-discount (G4), in that order. Validation =
  **reproduce the annotations on the 7 charts** (logic correctness), *not*
  expectancy and *not* threshold tuning (R5). No `SwingPoint` schema change.
- **Phase 1 — Objectives + POI entry (merged G3 + G8).** Draw-on-liquidity
  resolver reusing `liquidity.ts`; a POI-anchored limit-entry plan so RR is
  measured from the POI, not `livePrice` (R4). Attached as an **overlay**, not
  a `SetupType` change (R2). *Reordered 2026-07-10 (owner decision): Phase 0.5
  now runs after this phase, so Phase 1 keeps the Phase 0 posture — derived
  views + inert surfacing, validated on annotation fidelity. The
  verdict-affecting pieces (the fallback-guarded target cap with the R-multiple
  floor retained, and the targets-required veto G10) are built and displayed
  but consumed by no decision until the post-0.5 graduation gate.* See
  `research/phase1-plan.md`.
- **Phase 0.5 — Harness prerequisite (runs after the POI work).** Extend the
  shadow/backtest harness with a **limit-fill / no-fill outcome model** (R5)
  for the anticipatory plans Phase 1 now emits. Still blocks every phase that
  lets limit entries touch verdicts — including Phase 1's own graduation gate
  (target cap live, G10 veto live) and everything from Phase 2 on.
- **Phase 2 — Nested structure + MSS trigger.** First resolve the **G1 tier
  spike** (R3); then build the internal tier and the internal-MSS trigger (G9).
  Surface the Pro/Counter-Internal classifier in `intent.ts` checklists before it
  moves verdicts.
- **Phase 3 — FVG family.** FVG (G5) → size filter (G7) → iFVG + delivery (G6);
  unify OB/FVG/base zone under the POI abstraction (reuses G8 from Phase 1).
- **Phase 4 — Sanos trigger + combine policy.** Confirmation-mode entry (sweep +
  iFVG delivery + size + objective) for scalp/intraday; keep swing/position on
  anticipatory limits (§4.2). SMT (G11) last, bonus-only.

Gating: a phase graduates from shadow to live only when — **measured on the
extended harness (Phase 0.5)** — it demotes losing combos no worse than the
current engine and improves expectancy on the objective it targets. Phase 0 has
no such gate; its bar is annotation fidelity on the 7 charts. With the 2026-07-10
reorder, Phase 1 inherits Phase 0's bar (annotation fidelity, zero verdict
drift) and its verdict-affecting deliverables queue behind Phase 0.5 for the
graduation measurement.

---

## 10. G1 tier spike — success criteria (pre-registered)

**The question is decision quality, not fidelity.** We are *not* proving which
interpretation best matches Dreimann's boxes. We are deciding whether **nested
single-chart structure produces materially better trading decisions than the
existing cross-TF model, net of its added complexity.** Visual similarity is not
a metric; predictive value is. The 7 charts are a sanity check that both models
produce non-garbage structure — never the scoring set.

**Default (the asymmetry):** cross-TF is the incumbent and the simpler design, so
it **wins ties, wins on insufficient sample, and wins when the effect is
immaterial.** Nested must *earn* adoption by clearing every gate below. This
operationalizes "prefer lower complexity."

### Isolation — one variable only

Identical pipeline end to end; the **only** swapped component is how the
*internal* tier (and therefore the internal-MSS trigger and the
Pro/Counter-Internal classification) is derived:
- **Cross-TF (incumbent):** internal = the execution-TF's own structure.
- **Nested (challenger):** internal = second-prominence pivots on the context
  chart (single-chart two-tier).

POI selection, objective resolver, entry model, stop rule, sizing — all frozen.
If nested also perturbs any of those, the comparison is confounded and void.

### Scope — measure only where the tier can change a decision

The internal tier only touches (1) the Pro/Counter-Internal label, (2) the
internal-MSS trigger fire, (3) verdict/size changes flowing from those. Restrict
the whole test to confirmation-mode decisions on the execution TFs the intents
use (15M/1H/4H). Anticipatory limit entries that don't require the trigger are
out of scope — the tier can't move them, so including them only dilutes signal.

### Unit, population, outcome

- **Unit:** one decision = `(asset, execution-TF, closed bar)` → tuple
  `{direction, confirmed?, trigger-fired?, objective}`.
- **Population:** the 18-asset universe, walk-forward (as-of-bar, no lookahead —
  strength/objective are forward-looking per R1), over a window spanning up/down/
  range regimes.
- **Outcome (predictive metric):** replay forward from each decision — **WIN** if
  the objective is hit before invalidation, **LOSS** if invalidation first,
  **censored** if unresolved within a capped horizon of K bars. Score in **R**
  (objective/stop distance). No silent dropping of open trades (that inflates
  expectancy).

### The gates (pre-register all thresholds *before* running)

- **Gate A — Divergence.** Fraction of resolved in-scope decisions where the two
  models differ (direction, trigger-fire, or objective by > **0.25R**). If
  divergence < **10%**, **STOP → cross-TF**: the second tier rarely changes the
  decision, so complexity can't pay off even if it's always right on the rest.
- **Gate B — Lift on the disagreement set.** On decisions where they differ (that
  is where it matters), nested's expectancy must exceed cross-TF's by ≥ **+0.15R**
  mean, with a paired bootstrap 90% CI excluding 0, over ≥ **50** resolved
  disagreement trades per side (100 preferred). Below the sample floor → STOP →
  cross-TF (insufficient evidence loses).
- **Gate C — Aggregate & robustness.** The lift must also be **non-inferior on
  the full in-scope stream** (full-stream expectancy delta ≥ 0 — we are not
  improving rare cases while quietly hurting common ones), and hold in **both
  halves of the window** and in a **majority of assets** (not one token / one
  regime).
- **Gate D — Complexity ledger.** Enumerate the state nested adds (second pivot
  scale + its replay-safety surface, its own strong/weak, hysteresis interaction).
  Adopt only if the measured lift is judged worth that budget. A ~0.02R edge is
  not.

**Adopt nested iff A ∧ B ∧ C ∧ D. Otherwise cross-TF.**

### Validity controls
- No lookahead: bar-limited windows; forward-looking fields computed as-of-bar.
- No p-hacking: thresholds (0.25R, 10%, +0.15R, N=50, K) fixed before the run;
  no re-tuning after seeing outcomes.
- Censoring, not deletion, for unresolved trades.
- Regime coverage stated up front; a result only generalizes to sampled regimes.

### Pre-registration knobs (confirm before running)
Divergence floor (10%), objective-difference epsilon (0.25R), lift threshold
(+0.15R), min disagreement sample (50), horizon cap K. These are the author's
call — they change the verdict, so they are set once, here, and not touched again.
