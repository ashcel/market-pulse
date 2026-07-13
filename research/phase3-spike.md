# Phase 3 — i.mss trigger spike (H-LB vs CHoCH): pre-registered protocol

Drafted 2026-07-10. Status: **run 2026-07-10. Verdict: CHOCH RETAINED — H-LB fails Gates B and C.**

This is the gating spike for the `0.9.0-dev → 1.0.0` version bump. The
question is whether the **internal shift trigger** should change from the
current pivot-confirmed CHoCH (knowable `k` bars late) to the level-break
close-through (H-LB, knowable at bar close). Per the plan's rule, the verdict
must come from a pre-registered gated comparison — not a casual edit.

Companion: `phase2-spike.md` (where H-LB was discovered and falsified the
CHoCH formalization on fixture sanity). `analysis.md` §10 is the template.

---

## The question — decision quality, not visual fidelity

We are _not_ proving which trigger best matches Dreimann's annotations. We are
deciding whether **the H-LB level-break trigger produces materially better
trading decisions than the current CHoCH trigger, net of its risk.** Visual
match on the 7 Dreimann fixtures is a sanity check, never the scoring set.

**Default (the asymmetry):** CHoCH is the incumbent — it is already built,
already in the engine, and already producing the `0.9.0-dev` record. It **wins
ties, wins on insufficient sample, and wins when the effect is immaterial.**
H-LB must _earn_ adoption by clearing every gate below. This operationalizes
"prefer the trigger we already have unless a new one is clearly better."

---

## Isolation — one variable only

The pipeline is identical end to end; the **only** swapped component is the
internal-shift trigger:

- **Incumbent (CHoCH):** internal shift = a pivot-confirmed CHoCH on the
  execution TF — a new directional break that requires a _confirmed pivot_
  beyond the prior extreme. Knowable `k` bars after the break, where `k` =
  `pivotWindow(n)` on the exec chart.
- **Challenger (H-LB):** internal shift = the first execution-bar **close
  through** the most recent counter-trend fine-tier pivot high (for a long;
  mirror for a short), where "fine-tier" = half the standard pivot window
  (`Math.max(2, floor(pivotWindow(n) / 2))`). The pivot must be leg-scoped:
  anchored to the high that _originated the internal down-leg_, not the most
  recent micro-high on a shelf. Knowable at the closing bar's close — no
  pivot-confirmation wait.

Everything else is frozen: POI selection, objective resolver, entry model
(trigger bar close), stop rule (shift-origin swing), sizing, outcome walk. If
H-LB also perturbs any of those, the comparison is confounded and void.

### Leg-scoped anchor (the key design decision from phase2)

Phase 2 found that the naive "most recent fine high" anchor fires on every
micro-reclaim (8+ events on TRX) and picks the wrong level. The fix:

1. Identify the **originating high** of the current internal leg — the fine
   pivot high that began the counter-trend move (the highest fine high before
   the most recent low sequence in the opposite direction).
2. The trigger fires only on the first close through _that_ level, not any
   subsequent fine high on the same shelf.
3. Reset the anchor when a new leg origin prints (a higher fine high in the
   counter-trend direction after a confirming low).

This is the same leg-scoping insight EDR 0004 needed. Without it, H-LB is a
noise generator, not a trigger.

---

## Scope — measure only where the trigger can change a decision

The internal shift trigger only touches confirmation-mode decisions on the
execution TFs the intents use (15M/1H/4H). Anticipatory limit entries that
don't require the trigger are out of scope — the trigger can't move them, so
including them only dilutes signal.

Restrict to: the 18-asset universe, confirmation-mode decisions, exec TFs
15m/1h/4h, with intent-paired context 1h/4h/1d.

---

## Unit, population, outcome

- **Unit:** one decision = `(asset, execution-TF, closed bar)` → tuple
  `{direction, trigger-fired?, objective}`. Same unit shape as phase2.
- **Population:** the 18-asset universe, walk-forward (as-of-bar, no lookahead
  — strength/objective are forward-looking per R1), over a window spanning
  up/down/range regimes.
- **Outcome (predictive metric):** replay forward from each decision — **WIN**
  if the objective is hit before invalidation, **LOSS** if invalidation first,
  **censored** if unresolved within a capped horizon of K bars. Score in **R**
  (objective/stop distance). No silent dropping of open trades.

---

## The gates (pre-register all thresholds _before_ running)

- **Gate A — Divergence.** Fraction of resolved in-scope decisions where the
  two triggers disagree (one fires, the other doesn't, or both fire but on
  different bars). If divergence < **10%**, **STOP → CHoCH**: the trigger
  rarely changes the decision, so the risk of a new trigger can't pay off even
  if it's always right on the rest.
- **Gate B — Lift on the disagreement set.** On decisions where they differ
  (that is where it matters), H-LB's expectancy must exceed CHoCH's by ≥
  **+0.15R** mean, with a paired bootstrap 90% CI excluding 0, over ≥ **50**
  resolved disagreement trades per side (100 preferred). Below the sample
  floor → STOP → CHoCH (insufficient evidence loses).
- **Gate C — Aggregate & robustness.** The lift must also be **non-inferior on
  the full in-scope stream** (full-stream expectancy delta ≥ 0 — we are not
  improving rare cases while quietly hurting common ones), and hold in **both
  halves of the window** and in a **majority of assets** (not one token / one
  regime).
- **Gate D — Complexity ledger.** H-LB adds: a fine-tier pivot computation per
  evaluation, a leg-scoping anchor rule, and a close-through check. This is
  _less_ state than nested structure (no second stored tier, no
  strong/weak interaction) — but it does add a new trigger pathway that must
  be replay-safe and tested. Adopt only if the measured lift is judged worth
  that budget. A ~0.02R edge is not.

**Adopt H-LB iff A ∧ B ∧ C ∧ D. Otherwise retain CHoCH.**

---

## Validity controls

- **No lookahead:** bar-limited windows; forward-looking fields computed
  as-of-bar. Fine-tier pivots use only the closed-bar prefix.
- **No p-hacking:** thresholds (10%, +0.15R, N=50, K, epsilon) fixed before
  the run; no re-tuning after seeing outcomes.
- **Censoring, not deletion,** for unresolved trades.
- **Regime coverage stated up front;** a result only generalizes to sampled
  regimes.
- **Fixture sanity is never the scoring set.** The 7 Dreimann trades are
  walked as-of-bar to confirm both triggers produce non-garbage structure and
  that H-LB fires at the annotated i.mss level/time — but the verdict comes
  from the gates, not the fixtures.

---

## Pre-registration knobs (confirm before running — do not touch after)

| Knob                         | Value                                                   | Rationale                                                                           |
| ---------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Divergence floor             | **10%**                                                 | Same as phase2; if the trigger rarely changes the decision, the risk isn't worth it |
| Lift threshold               | **+0.15R**                                              | Same as phase2; the bar for replacing an incumbent                                  |
| Min disagreement sample      | **50 per side**                                         | Same as phase2; below this, insufficient evidence                                   |
| Objective-difference epsilon | **0.25R**                                               | Same as phase2; objectives differing by less are "same"                             |
| Horizon cap K                | `INTENT_MAX_HOLD_BARS`                                  | The engine's own max-hold; consistent with phase2                                   |
| Fine-tier window             | `max(2, floor(pivotWindow(n) / 2))`                     | Half the standard pivot window; "one octave down"                                   |
| Leg-scoping                  | Required                                                | Without it, H-LB fires on every micro-reclaim (phase2 finding)                      |
| Data window                  | 1000 closed bars per (asset, execTF), ending 2026-07-10 | Same as phase2 for comparability                                                    |

---

## Frozen and shared components

Both arms use identical:

- **Context-structure swing bias** (`structureLean`) — the directional read
  from the context TF.
- **Objective resolver** — `resolveObjectives` preferred candidate; empty → no
  decision.
- **Entry** — trigger bar close.
- **Stop rule** — internal tier's shift-origin swing.
- **Outcome walk** — stop-first, horizon = `INTENT_MAX_HOLD_BARS`, censored at
  horizon scored mark-to-close, never dropped.

The **only** difference is the trigger rule:

| Arm                   | Trigger rule                                                                 | Knowable when              |
| --------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| **CHoCH (incumbent)** | New internal CHoCH in the bias direction (pivot-confirmed)                   | `k` bars after the break   |
| **H-LB (challenger)** | First exec-bar close through the leg-scoped fine-tier counter-trend high/low | At the closing bar's close |

---

## Implementation plan

1. **Spike harness** — `research/scripts/phase3-spike/`:
   - `fetch-spike-data.ts` — reuse the phase2 universe data fetcher (18 assets,
     exec 15m/1h/4h, context 1h/4h/1d, 1000 closed bars).
   - `run-spike.ts` — gated comparison runner. For each (asset, execTF, bar):
     evaluate both triggers as-of-bar, record `{fired, bar, direction,
objective}`, walk forward to outcome. Compute gates A–D.
   - `leg-scope.ts` — the leg-scoped fine-tier anchor logic (shared utility).
   - `fixture-sanity.ts` — walk the 7 Dreimann fixtures as-of-bar, confirm
     H-LB fires at the annotated i.mss level/time.

2. **Challenger trigger** — implement H-LB behind the spike harness only. **No
   engine behaviour change to `main`** until the gate passes. The trigger is a
   function that takes (candles prefix, bias direction) and returns
   `{fired: boolean, atBar: number, level: number}`.

3. **Run the gated comparison** — record raw results + verdict in this file
   and persist via the `record-backtest` CLI (`kind=i-mss-spike`).

4. **Decide:** adopt H-LB, or retain CHoCH. Either way the question is
   _closed_ and the engine is freezable.

---

## Results — run 2026-07-10

Data: live Binance spot, 18-asset universe, 15m/1h/4h/1d, 999 closed bars each
(window 2026-05-29T22:00Z → 2026-07-10T12:00Z), fetched directly (no proxy
needed — Binance did not rate-limit the capture). Raw gate output persisted at
`research/scripts/phase3-spike/results-2026-07-10.json` and as
`backtest_run` `66e27582-f097-4c50-bbc2-be7e051b032c` (`kind=i-mss-spike`) via
`record-backtest`.

Population: 260 in-scope units (bar where ≥1 arm fired). CHoCH fired 116
decisions, H-LB fired 145. Only 1 unit had both arms fire on the same bar —
259/260 units disagreed.

| Gate                             | Result                                                                                                                                                                                                                                            | Threshold                                                  | Pass?                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **A — Divergence**               | 99.6% of in-scope units disagree                                                                                                                                                                                                                  | ≥ 10%                                                      | **PASS**                                                                                  |
| **B — Lift on disagreement set** | mean ΔR = **+0.005R** (H-LB − CHoCH), 90% bootstrap CI **[−0.070, +0.080]** (includes 0), resolved N = 53 (CHoCH) / 63 (H-LB) — sample floor of 50 cleared on both sides                                                                          | ≥ +0.15R, CI excl. 0                                       | **FAIL**                                                                                  |
| **C — Aggregate & robustness**   | full-stream ΔR = +0.004R; half 1 ΔR = **−0.003R** (not positive); half 2 ΔR = +0.015R; 8/18 assets H-LB-positive (not a majority)                                                                                                                 | full-stream ≥ 0 AND both halves > 0 AND majority of assets | **FAIL** (full-stream barely non-negative, but half 1 negative and asset majority missed) |
| **D — Complexity ledger**        | H-LB adds a fine-tier pivot computation, a leg-scoping anchor rule, and a close-through check — a real new pathway to keep replay-safe and tested, for a measured lift indistinguishable from 0R (+0.005R, CI straddles 0). Not worth the budget. | judged                                                     | **FAIL** (no lift to spend the budget on)                                                 |

**Gate A passed** — the trigger choice does change the decision almost every
time (99.6% divergence), so the risk of a new trigger _could_ in principle
pay off. It didn't: **Gate B fails outright** — the disagreement-set lift is
+0.005R, essentially zero, nowhere near the pre-registered +0.15R bar, and the
90% CI straddles 0. **Gate C fails** too — the full-stream delta is barely
non-negative (+0.004R, noise-level) but the first half of the window is
_negative_ (−0.003R) and only 8 of 18 assets show a positive H-LB edge, so the
(already-negligible) effect isn't even consistently positive across time or
assets. Per the pre-registered asymmetry, insufficient/negative evidence loses
— CHoCH keeps the incumbency.

**Fixture sanity** (`fixture-sanity.ts`, 6 of the 6 committed Dreimann
fixtures — the docs' "7" count is stale, noted in the script's own output):
H-LB fired in the 48h pre-entry window on 4/6 fixtures (zec-tp, ethfi-sl,
jup-tp, fet-tp); CHoCH fired on 2/6 (jup-tp, fet-tp) in the same window. On
**trx-tp3** — the one fixture with a numeric i.mss annotation transcribed into
`labels.json` (~0.3296) — H-LB produced **no fire at all** in the pre-entry
window, so the tolerance check is a **NO MATCH**. This is reported, not
tuned-until-matching (tuning a single fixture would be the p-hacking the
protocol forbids), and it does not change the verdict — the gates already
failed on their own terms. It's additional color: H-LB's leg-scoped anchor
does not reliably reproduce even the one annotated i.mss level in this fixture
set, consistent with a trigger that fires more often (145 vs. 116 decisions)
without being more informative.

## Verdict: **CHOCH RETAINED**

H-LB does not clear Gate B or Gate C. Per the pre-registered rule (adopt iff A
∧ B ∧ C ∧ D), the incumbent CHoCH trigger is retained. The i.mss trigger
question is **closed**: the internal shift stays a pivot-confirmed CHoCH, not
a level-break. This was the only true blocker to `1.0.0` — WS6 (bump
`ENGINE_VERSION` to `1.0.0`) is now unblocked.

---

## Acceptance

A written verdict with gate evidence (A pass/fail, B lift + CI + sample, C
robustness, D complexity assessment). The trigger question is no longer open.
**This is the only true blocker to `1.0.0`.** **Met 2026-07-10** — see
Results above.

If H-LB passes all gates: implement it in the engine, bump to `1.0.0`, start
the clock.

If H-LB fails any gate: retain CHoCH, bump to `1.0.0`, start the clock. The
trigger question is still closed — CHoCH is the frozen trigger. **This
branch was taken** — CHoCH is retained, unchanged in the engine.

Either outcome unblocks WS6.
