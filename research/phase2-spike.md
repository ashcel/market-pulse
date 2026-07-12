# Phase 2 — G1 tier spike: results and verdict

Ran 2026-07-10 against the pre-registered protocol in `analysis.md` §10.
Scripts: `research/scripts/phase2-spike/` (data fetcher, gated runner, fixture
sanity checks); raw gate output: `research/scripts/phase2-spike/results-2026-07-10.json`.

## Verdict

**Cross-TF retained. Nested single-chart structure is rejected — G1 is
resolved.** The challenger failed Gate B on both the sample floor and the
threshold, and per the pre-registered asymmetry ("insufficient evidence
loses"), the incumbent wins. No second pivot tier, no nested strong/weak, no
new structure state will be built.

**The deeper finding, though, is that the question was mis-posed.** Neither
arm — not cross-TF, not nested — reproduces the i.mss annotations Dreimann
actually drew, and the root cause is not _which chart supplies the internal
tier_. It is the **trigger definition**: his internal shift is a _closed-bar
close through a drawn internal level_, knowable at that bar's close, while
both arms formalize it as a _pivot-confirmed CHoCH_, knowable only `k` bars
later — and on the TRX chart, never. Section "The i.mss finding" below;
consequences at the end.

## The gated comparison (pre-registered)

- **Incumbent (cross-TF):** internal tier = the execution TF's own structure.
- **Challenger (nested):** internal tier = fine pivots (half the swing pivot
  window — one octave down, fixed before running) on the context chart, so
  both tiers share one pivot space.
- **Frozen and shared:** context-structure swing bias (`structureLean`),
  objective (`resolveObjectives` preferred candidate; empty → no decision),
  trigger _rule_ (new internal CHoCH in the bias direction), entry (trigger
  bar close), stop _rule_ (internal tier's shift-origin swing), outcome walk
  (stop-first, horizon = `INTENT_MAX_HOLD_BARS`, censored at horizon scored
  mark-to-close, never dropped).
- **Pre-declared deviations:** the §6 "inside a POI" gate was dropped
  (identical for both arms, so it cannot favor either; it would have starved
  Gate B's sample); direction cannot diverge (bias shared), so divergence is
  trigger-fire mismatch; paired unit = (asset, execTF, bar), a non-trading arm
  contributes 0R — resting flat is its decision there.
- **Data:** 18-asset universe × exec 15m/1h/4h with intent-paired context
  1h/4h/1d, 1000 closed Binance spot bars each, window ending 2026-07-10
  (15m ≈ 10 days, 1h ≈ 42 days, 4h ≈ 167 days of history; regime coverage is
  whatever this window contained — results generalize no further).

### Gate results

| Gate                       | Threshold                                         | Measured                                                                  | Result                       |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| A — divergence             | ≥ 10% of in-scope decisions                       | **100%** (139/139 units single-arm; the arms never fired on the same bar) | pass                         |
| B — lift on disagreements  | ≥ +0.15R mean, 90% CI > 0, ≥ 50 resolved per side | +0.146R, CI [0.056, 0.238], resolved **cross-TF 50 / nested 3**           | **FAIL** (floor + threshold) |
| C — aggregate & robustness | full-stream ≥ 0, both halves, majority of assets  | +0.146R; halves +0.135/+0.163; 15/18 assets                               | pass                         |
| D — complexity ledger      | lift worth the state budget                       | moot given B                                                              | —                            |

**Adopt nested iff A ∧ B ∧ C ∧ D → not met → cross-TF.**

### Honest readings of the numbers

- **The apparent lift is an abstention artifact.** Both arms' raw expectancy
  is _negative_ in this window (cross-TF −0.21R over 117 decisions; nested
  −0.22R over 22). The +0.146R delta is dominated by the 117 units where
  nested simply didn't trade (contributing 0R) while cross-TF lost — "not
  trading beats trading a losing stream", not "nested reads structure
  better".
- **The challenger is structurally starved, not unlucky.** Its internal
  events live on context-bar closes with a fine-tier confirmation lag on an
  already-coarse chart (on a 1d context, ~6 _days_), against horizons counted
  in execution bars — 19 of its 22 decisions censored. This is inherent to
  "internal tier on the context chart", not a parameter accident.
- **The negative expectancy of both arms condemns the spike's simplified
  pipeline** (CHoCH-close entry, shift-origin stop, nearest-draw objective,
  no location/POI/confidence gating), **not the production engine** — none of
  the engine's actual gates were in the loop. It does mean neither
  formalization of "confirmation trigger" is worth shipping as-is.

## The i.mss finding (fixture sanity — never the scoring set)

Sanity scripts walked the trx-tp3 and zec-tp fixtures as-of-bar:

1. **Neither arm fires before entry on either fixture.** No aligned CHoCH,
   cross-TF or nested, in the 36–60h before either labeled entry.
2. **TRX, the sharpest case:** the annotated i.mss (~0.3296, Jul 8) is a
   shelf of dozens of 15m highs (0.3290–0.3301). At `pivotWindow = 10`
   (±2.5h), that entire shelf is _one leg_ — the internal high the trader
   drew does not exist in the incumbent's pivot substrate. As-of his entry
   (02:30Z Jul 9) the exec structure still reads **downtrend**; and across
   the _entire fixture window_ — including after entry, while the trade ran
   to TP3 — the 15m structure **never prints a bullish CHoCH**. The trade
   that motivated this whole phase is invisible to both formalizations.
3. **The trigger is the gap, not the tier.** A CHoCH needs a _confirmed
   pivot_ beyond the prior extreme — knowable `k` bars after the break.
   Dreimann's shift is the _close through the level_ — knowable at that
   bar's close. Confirmation-lag plus substrate coarseness, on the same
   chart he trades.

### Emergent hypothesis H-LB (not gate-tested — do not adopt from this)

_i.mss ≈ the first execution-bar **close through** the counter-trend internal
high, where the internal high is a fine-tier (half-window) pivot on the
**same execution chart**._ Fixture sanity:

- **zec-tp: clean match.** First close above the fine high 466.68 at 01:00Z
  Jul 9 — the chart's i.mss line sits at ~466, and the event precedes the
  12:45Z entry.
- **trx-tp3: the level exists, the anchor rule doesn't.** A fine-tier pivot
  prints at 0.32961 (08:00Z Jul 8) — matching the drawn ~0.3296 — but the
  naive "most recent fine high" anchor fires on every micro-reclaim (8+
  events) and its nearest event picks a different line (0.32911). The
  trader's line stays anchored at the high that _originated the internal
  down-leg_; H-LB needs that leg-scoped anchor (the same leg-scoping insight
  EDR 0004 needed) plus a counter-trend qualifier before it is a trigger.

H-LB is a _new challenger discovered after seeing data_. Per the no-p-hacking
rule it gets **no credit from this spike's gates**; adopting it requires its
own pre-registered run (thresholds fixed first, same asymmetry). What this
spike establishes is only: (a) it is the _right shape_ of hypothesis — both
CHoCH arms are structurally unable to represent the annotated trigger; (b) its
complexity budget is far below nested structure — one derived trigger read
(fine pivots exist per-evaluation, no second stored tier, no second
strong/weak, no hysteresis interaction).

## Consequences

1. **G1 resolved: cross-TF.** The `internal-external-structure-deferred`
   decision stands, now on spike evidence rather than inheritance. No nested
   structure model. The engine's existing shape — context TF supplies the
   swing tier, execution TF supplies the local read — is retained.
2. **G9 must be reformulated before it is built.** "Internal MSS trigger =
   internal-tier CHoCH" (analysis.md §6) is falsified as a representation of
   the annotated trigger. The replacement candidate is H-LB
   (close-through-level with a leg-scoped fine-tier anchor), to be spec'd and
   **pre-registered as its own spike** — gates in the §10 style, incumbent =
   no trigger (wait for the engine's existing confirmation), before any
   engine work.
3. **P3 (FVG family, G5/G6) is independent of all of this** and can proceed
   next; the Sanos trigger never needed the internal tier.
4. The Phase 1 graduation gate continues to accumulate anticipatory-record
   volume in parallel (EDR 0010) and is unaffected.
