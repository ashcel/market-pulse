# EDR 0023: The forensics measurement boundary — what review may compute, and what it may claim

- **Status:** Accepted (2026-07-26) — R4-T1 spec commit; frozen before any forensics code is written (R4 definition of done: "definitions doc merged before any forensics code").
- **Scope:** the review plane only — which post-hoc measurements over the user's own trades are permitted, what evidence each one requires, and what may be said about their distributions. **No engine decision/trigger semantics change and no `ENGINE_VERSION` change** — the 2.0.0 forward-test clock keeps running untouched. R4 reads outcomes; it never changes what the engine decides.
- **Depends on:** EDR 0011 (record-semantics boundary — the classification discipline this EDR reuses on a different plane); EDR 0017 decision 3 (R-multiples only where a stop is evidenced); EDR 0022 decisions 2 and 3 (M5 cohort analytics deferred, M2 historical replay deferred and redesigned to stamp-at-open only).
- **Companion:** `docs/forensics-definitions.md` — the frozen formula specification, `FORENSICS_DEFINITIONS_VERSION 1.0.0`. This EDR states the boundary; that document holds every formula, sign convention, window rule, threshold, unavailable-reason and worked example. Formulas are **not** restated here.

## Problem

R4 asks the product to tell a user what they actually did — MAE/MFE, exit
efficiency, stop discipline, re-entry latency, sizing variance — and to name
the habit those facts describe. Every one of those numbers is computed *after*
the trade closed, from data the system did not observe at the time. That is
exactly the shape of the thing this project has repeatedly refused to build:
EDR 0022 deferred historical replay, and the verdict protocol forbids
retrospective reinterpretation of the record.

So the milestone needs a boundary drawn before the code exists, answering
three questions that will otherwise be answered implicitly and inconsistently
by five different tasks:

1. Which post-hoc computations are *measurement* (permitted) and which are
   *replay* (deferred)?
2. What evidence does a given number require before it may be shown at all,
   and what is shown when that evidence is absent?
3. What may be claimed about a pile of these numbers?

The R4 plan states four honesty rules. This EDR makes them decisions, with
their reasoning and their rejected alternatives, so R4-T8 has something to
review against and so a future task cannot relax one by accident.

## The four decisions

### 1. Forensics are measurement, not replay

**Reading a public kline series over an interval in which the user
demonstrably held a position is measurement and is permitted. Re-running the
engine over history to ask what it would have said is replay and stays
deferred.**

The distinguishing test is *whose output is being reconstructed*. MAE asks
"what price traded while this position was open" — a fact about the market,
answered by a public series, independent of anything this system did or
believed. A replay asks "what verdict would `evaluate_symbol` have produced at
14:32" — a fact about *our own instrument*, answered by re-running code whose
inputs (session levels, combo stats, holds, the demotion statistic) have all
moved since, and whose output would then be compared against outcomes it was
never live for. The first cannot flatter the engine. The second is
structurally capable of nothing else.

Two consequences are load-bearing:

- **No look-forward.** Excursions are measured over `[opened_at, closed_at]`
  only. "What the trade did after you exited" is not defined in 1.0.0 and must
  not be computed and rendered next to these numbers — it is a counterfactual
  wearing a measurement's clothes.
- **Measurement error is disclosed, never interpolated.** Candle boundaries
  make MAE/MFE inclusive of tape just outside the position's life. The
  definitions doc's answer is to stamp the inflation bound on the row and pick
  the finest affordable interval; the rejected answer is to synthesize an
  intrabar path to recover precision, which fabricates price action and lands
  back on the replay side of the line.

### 2. Stamp-at-open is live-only and is never reconstructed

**Market context on a trade — regime, per-intent verdict, session, active
catalysts and their impact scores — is captured while the position is open,
from the read models as they read at that instant, and is never backfilled.
A trade opened before the stamper existed has `context: null`, permanently.**

The subtle case is the one that matters. `eval_log` already stores a
timestamped verdict and regime for every symbol every five minutes, so
"reconstructing" the context of a trade opened last Tuesday is a single query
against rows that genuinely existed. It is still forbidden. A stamp is
evidence that the system said this thing at that moment and that the moment
was observed; a lookup is a claim about the past assembled afterwards by code
that already knows how the trade turned out. Only the first can be used to
argue "you took this trade against a caution verdict" without the argument
being circular. This is EDR 0011's boundary — *does this change what gets
recorded, or only how the record is read* — applied to a new plane: a
backfilled stamp changes what the record contains, retroactively, which the
forward-test discipline has never permitted.

There is also a mechanical reason that makes the rule self-enforcing. The
Catalyst Impact Score is a function of proximity (`WEIGHT_PROXIMITY` is 30 of
100 points in `backend/app/events/impact.py`), and the catalyst read models
filter on SQL `now()`. Recomputing an event's impact after the fact returns a
different number for the same event. So the stamp stores computed impact
values rather than references, and any backfill would be provably wrong, not
merely unprincipled.

Enforcement is structural, not conventional: `stamped_at` is `NOT NULL` and
comes from the observing process's clock, the context table is append-only
(corrections are new rows with `supersedes_id`), no code path may build a
context row from a `BinanceTrade` row, and a stale engine read — more than
three worker ticks old — stamps `null` with `verdict_source: "stale"` rather
than presenting a stale value as the value at open.

Accepted cost: the stamper is net-new observation infrastructure (nothing in
the current worker sees a position while it is open), and every trade already
closed has no context and never will. That is the honest outcome of the rule,
not a gap to be quietly filled later.

### 3. R-multiples stay gated on an evidenced stop — and the gate's bias is disclosed

**An R-denominated value may be produced only when `stop_loss` is non-null on
the trade row and the entry-to-stop distance is greater than zero. Everywhere
else: percent of entry, plus MAE/MFE.** This is EDR 0017 decision 3, unchanged
and now test-asserted at the row level rather than only at the aggregate
level.

What is new is a fact the R4-T1 audit surfaced and that this EDR records
because it changes how the gate must be read. The sync populates `stop_loss`
**only when the order that produced the closing fill was a `STOP` /
`STOP_MARKET`** — that is, only when the stop was *hit*. A stop that was placed
and never needed leaves the column null. So the stop-evidenced subset is not a
random sample of the user's trades; it is approximately the set of trades that
lost at their stop. Consequences accepted here:

- R distributions built from that subset are distributions over stop-outs and
  must be labeled as such. This is a live issue for the existing `compute_rr`,
  which averages R over exactly this subset — R4-T2's audit covers it.
- "Stop discipline" in 1.0.0 is therefore defined narrowly as *stop-hit
  quality* (adverse fill slippage, violation depth, realized-vs-promised R),
  not as *stop-honoring behavior*. The habit a user would most want named —
  "you widen your stop" — is not implementable, because a widened stop and no
  stop are the same NULL. The definitions doc says so in the metric's own
  definition rather than approximating it.
- The tempting fix — take the stop from `execution_records.stop_price`, which
  is a genuinely evidenced placed stop for IQ-executed trades — is **not**
  adopted silently. There is no join between the two tables today, and R1 as
  frozen gates R on the trade row. Adopting an execution-record stop as
  evidence is a `FORENSICS_DEFINITIONS_VERSION` bump.

The companion rule: **absence is a first-class value.** Every metric returns an
explicit unavailable state with one reason from a closed enumeration — never a
zero, never a silent null, never an omitted field. The sharpest case is
`MAE = 0`, which is *available* and means "measured, and the trade never went
against you"; collapsing it into the same rendering as "we cannot measure
this" would make every unmeasurable trade look like a perfectly timed entry.

### 4. Distributions are counts only — no edge claims

**Aggregates over forensics rows are counts, ratios, dispersions and
histograms. Nothing in the review plane is presented as a probability, a
forecast, or an expectancy sold as edge.**

Concretely: "4 of your 11 losses were re-entered within five minutes" is
permitted; "re-entering within five minutes has a 27 % win rate" is not, and
"avoid re-entering within five minutes to improve expectancy" is definitely
not. "One position at 2.5× your median notional" is permitted; linking that
outlier to its outcome as an effect is not. The population standard deviation
(divide by N) is specified in the definitions doc rather than the sample one
precisely because we are describing the set of trades the user took, not
estimating a parameter of a population they were drawn from — the N−1 form
would smuggle in an inferential claim through a default.

This is EDR 0022 decision 2 held to: per-trade forensics deliver the actionable
subset now *because* they are facts about individual trades; the statistical
claims wait for M5's pre-registered protocol at n ≥ 30 per segment. The
deferral is what makes shipping forensics honest, so weakening rule 4 would
retroactively invalidate the reason R4 exists.

The AI memo (R4-T7) inherits this without exception: it may restate rows that
exist and must cite them; unsupported claims are **dropped** by the
groundedness check, not softened into hedged language. A hedge is still the
claim.

## What was intentionally rejected

- **Post-hoc engine replay to fill in "what the engine said when you opened
  this."** The reconstruction is cheap and the rows exist — which is precisely
  why the rule has to be explicit rather than incidental. Deferred with EDR
  0022 decision 3; stamp-at-open is the forward-only substitute.
- **Backfilling context by querying `eval_log` at `evaluated_at ≈ opened_at`.**
  Rejected as decision 2's central case, and independently unsound because
  impact scores are proximity-dependent and the catalyst read models filter on
  `now()`.
- **Synthesizing a stop to give every trade an R value.** Rejected in EDR 0017
  and re-rejected here in its subtler form: inferring an "intended stop" from
  MAE, from account risk, or from the Trading Constitution's configured risk
  percent. An R computed from a stop the user never placed is fake precision
  about their own risk.
- **Clamping ugly-but-true numbers.** A losing trade's exit efficiency is
  negative and is shown negative. Where a ratio genuinely carries no
  information — a denominator at tick-noise scale — the metric is made
  *unavailable with a stated reason and a stated threshold*, not quietly
  clamped into a plausible-looking range.
- **Interpolating intrabar price paths** to sharpen excursions at the candle
  boundaries. Fabricated path data; the row carries a disclosed inflation
  bound instead.
- **Estimating excursions for rows whose `opened_at` is estimated.** That
  timestamp is a hard-coded `closed_at − 5 min` fallback, not an observation;
  a window built on it is fiction with a number attached. Those rows report
  unavailable.
- **Approximating scale-outs as one trade.** The sync writes one row per
  realized-PnL event with no grouping key, so a three-tranche exit is three
  rows that share an entry price and overlap in time. Rather than average them
  into a synthetic "position", 1.0.0 detects the group heuristically and
  reports the affected metrics as undefined for those rows — an explicit hole
  beats a plausible fabrication. A persisted `position_group_id` is the real
  fix and is named as such.
- **Extending the engine's `TokenTimeframe` to reach 1-minute klines.** The
  review plane needs a finer interval than the engine's timeframe ladder
  offers; the answer is a raw-interval fetcher in the backend worker module,
  not a new member on an engine type. Review-plane needs do not get to widen
  engine surfaces.

## Validation performed

Specification only — this EDR and `docs/forensics-definitions.md`. No `.py`,
`.ts`, or `.tsx` file was modified; no engine file was read for anything but
citation; no migration was written or applied. The claims about the existing
data model were verified against the code they cite
(`backend/app/binance_review/{models,enrichment,service,constants}.py`,
`backend/app/review/analytics.py`, `backend/app/worker/{binance,passes,config}.py`,
`backend/app/events/impact.py`, `backend/app/execution/{models,binance_client}.py`,
`engine/smc/{sessions,quant}.py`, and migration
`f1a2b3c4d5e6_binance_review_models.py`), and the ten gaps this surfaced are
recorded in §9 of the definitions doc rather than assumed away.

Measurable validation lives in the R4 task DoDs that implement these
decisions: R4-T3's pure-function tests are seeded from the definitions doc's
worked examples (decisions 1 and 3); R4-T4/T5 carry the append-only,
never-backfilled context constraints and the `stamped_at` bound test (decision
2); the R-gate test that fails if a non-stopped trade renders an R value
(decision 3); the counts-only distributions view and the groundedness check's
failing-case test (decision 4); and R4-T8 reviews the whole diff against this
EDR and the definitions doc.

## Future extension points

1. **`FORENSICS_DEFINITIONS_VERSION` bumps.** Any formula, threshold, window
   rule, sign convention or unavailable-reason change bumps the constant and
   re-stamps computed rows; rows at different versions are never pooled into
   one distribution. The first likely bump is adopting
   `execution_records.stop_price` as R-evidence once the join in finding F2
   exists — which would materially widen R coverage and partially close the
   stop-discipline gap in decision 3.
2. **Sync-scope change to close the stop-evidence bias.** `/fapi/v1/allOrders`
   already returns protective orders that were placed and never filled; the
   sync keeps only the order behind the closing fill. Persisting the rest
   would turn "stop discipline" from stop-hit quality into the behavioral
   measurement it is meant to be. It is a sync and schema change with its own
   review, not a formula tweak.
3. **M5's pre-registered cohort protocol.** When n ≥ 30 stamped, closed trades
   accumulate in major segments, the frozen protocol executes and extends
   evidence discipline from these per-trade facts to statistical claims. Only
   that protocol may relax decision 4, and only for the claims it
   pre-registers.
