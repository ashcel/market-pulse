# EDR 0001: Swing stops anchor on defended leg extremes; proximity logic keeps raw pivots

- **Status:** Accepted, implemented (2026-07-09)
- **Scope:** `buildRiskPlan` in `src/lib/engine/quant.ts` (the `"swing"` stop method — the shipped default in `DEFAULT_RISK_SETTINGS`, `CRYPTO_RISK_SETTINGS`, and the preferences store)
- **Evidence fixtures:** `src/lib/engine/sr-candidates.test.ts`, `src/lib/engine/defended-stop.test.ts`

## Problem

The engine derives support/resistance levels from raw confirmed pivots (`computePivots`). Raw pivots can contain _same-kind runs_ — consecutive highs (or lows) with no confirmed opposite pivot between them, typically because a shallow pullback after a steep thrust cannot confirm as a pivot (pre-thrust bars inside its ±k window are more extreme). The run's members belong to a single swing leg.

This creates a tension between two consumers of "the nearest level":

- **Proximity logic** (distance-to-structure warnings, entry-location grading, retest detection) wants the _nearest touch_ — the first place price historically reacted, even if it's an interior member of a leg.
- **Stop placement** wants the _defended level_ — the leg extreme that buyers/sellers actually held. A stop at an interior touch (e.g. the newest low of a `50 → 48 → 52` down-leg at 52) is a wick-out magnet: price can sweep it without violating the structure the trade is premised on. The defended level for that leg is 48.

Before this change, the swing stop method anchored on the nearest raw pivot — the proximity answer applied to the stop question.

## Alternatives considered

1. **Wholesale migration of `nearestSupport`/`nearestResistance` to alternation-collapsed swings** (the original proposal). Every S/R consumer — analytics distances, setup classification thresholds, risk plan, location grading, intent trigger levels — would have read leg extremes. **Rejected on fixture evidence** (see below).
2. **Status quo** (raw pivots everywhere). Rejected: keeps the wick-out stop, the one scenario where the raw answer is demonstrably wrong.
3. **Anchor stops on `structure.lastLow`/`lastHigh`** (the most recent labeled swing from `computeMarketStructure`). Rejected: the most recent swing low can sit _above_ current price after a breakdown, requiring extra guards, and it isn't necessarily the nearest defended level below entry. Selecting "nearest collapsed swing on the correct side" via the existing `nearestSupport`/`nearestResistance` helpers is both simpler and more correct.
4. **Add a buffer below the defended level** (e.g. stop = level − 0.1·ATR). Deferred: the current convention places stops _at_ the level; changing that is a separate decision with its own evidence bar, and bundling it would muddy attribution of behavior changes.
5. **Cap stop width** (fall back to the raw level when the defended extreme is more than N·ATR away). Deferred: dollar risk is invariant under stop width (sizing shrinks instead), and the census showed no pathological widths on deterministic data. A cap adds a discontinuity for no demonstrated need.

## Evidence

The decision was driven by adversarial fixtures built _before_ implementation (`sr-candidates.test.ts`), constructed after a design review challenged the wholesale migration ("assume the algorithm is incorrect until proven otherwise"):

- **Scenarios A/B (right-edge runs from unconfirmed pullbacks):** raw pivots keep the nearer, still-meaningful level (a broken-then-lost polarity level; the first demand shelf); collapsing discards it. Raw wins for proximity.
- **Scenario C (tight cluster of run highs):** raw reports the supply band's proximal edge — the honest "you are at resistance" read; collapsed hides it. The theoretical collapsed benefit (no premature breakout call inside the band) cannot materialize: pivot-derived resistance sits above close by construction, so `classifySetup`'s breakout branch is only reachable via the candle fallback, which alternation-collapsing does not change.
- **Scenario D (run of lows with an interior newest touch):** split verdict. Raw's 52 is the honest nearest demand; collapsed's 48 is the defended level a stop belongs under. **This scenario is the entire justification for this EDR: each algorithm wins for a different consumer, so the answer is per-consumer, not global.**
- **Subset invariant (property-tested):** `toAlternatingSwings` output ⊆ input with run extremes preserved, so collapsed levels are never nearer than raw levels, and a qualifying candidate exists in the collapsed set iff one exists in the raw set (fallback behavior is identical).

## Decision

Inside `buildRiskPlan` only, compute defended levels by feeding the existing private `nearestSupport`/`nearestResistance` selectors the alternation-collapsed pivot set (`toAlternatingSwings(pivots)`), and use them **only** in the swing-stop expressions:

- long: `stop = min(defendedSupport, entry − 0.7·ATR)`
- short: `stop = max(defendedResistance, entry + 0.7·ATR)`

Raw levels remain the inputs to `target1`, the entry zone, `analyticsFor`, `classifySetup`, location grading, and intent trigger levels. No new selection algorithm was introduced — the change reuses the two existing utilities with a different candidate set. Total production diff: ~7 lines in one function.

## Why this approach

- **The evidence is per-consumer, so the fix is per-consumer.** Scenario D is the only case where collapsed swings beat raw pivots, and the stop is the only consumer living in that case.
- **Provable safety envelope.** The subset invariant guarantees stops never _tighten_ — the change can only widen a stop past a weak interior level, never create a new wick-out. Dollar risk is invariant (`positionSize = maxDollarRisk / riskPerUnit`), so a wider stop shrinks size, not the loss budget.
- **No decision flips at shipped settings.** `target1 = max(resistance, entry + 1.8·riskPerUnit)` structurally floors reward/risk at 1.8, above both shipped minimums (1.6 crypto, 1.8 default), so the R:R gate cannot fail from a wider stop and `decision`/`setupType`/`confidence` are unchanged at defaults. Only plan geometry moves. (Users who manually set `minimumRewardRisk > 1.8` can see flips on resistance-bound targets — accepted.)
- **Replay determinism preserved.** `toAlternatingSwings` is a pure forward fold with deterministic tie-breaks; identical inputs produce identical plans (tested).

## Tradeoffs accepted

- **Wider stops → smaller positions** in the affected cases. This is the point: the old size was computed against an understated risk.
- **Unbounded widening** when the defended extreme is far from entry. Accepted without a cap for now (see alternative 5); the census bounds the observed magnitude.
- **Still-forming leg drift:** the current leg's extreme can extend as more same-kind pivots confirm, stepping the stop wider between evaluations. The same drift class existed with raw pivots (new confirmations move the nearest level too); held verdicts pin their levels at adoption, so nothing already held flickers.
- **Shadow-record population mix:** shadow records pin `stop`/`target1`/`target2` at adoption, so in-flight records are untouched, but records opened after this change settle against wider stops — expect fewer stop-outs and more time-stop expiries going forward. Setup×regime demotion stats will mix pre/post populations across the 2026-07-09 deploy.

## What was intentionally rejected

The **wholesale S/R migration** — moving all of `nearestSupport`/`nearestResistance` to collapsed swings. The fixtures showed it degrades every proximity-facing consumer (mutes at-resistance warnings, discards polarity levels and first demand shelves) to fix a problem only the stop has. The premise "interior run pivots are noise" was imported from swing _labeling_ (where same-kind adjacency comparison genuinely fabricates HH/LH) into level _selection_ (which never makes that comparison) — the fixtures falsified the transfer. Do not resurrect the wholesale swap without new evidence; `computeTrendLines` is the other legitimate collapsed-swing consumer (it anchors legs, not proximity).

## Risks

- Real market data has more same-kind runs than the smooth deterministic mock series, so the live change rate will exceed the census's 3.2% and individual widenings can be scenario-D-sized (52 → 48 ≈ 9% of price). Mitigated by the dollar-risk invariance and the never-tighten guarantee.
- `runBacktest` cannot detect a regression here: it computes its own ATR-multiplier stop and never calls `buildRiskPlan`. An unchanged backtest is **not** evidence of safety for this change — validation had to target the plan directly (and did).
- The rare `risk.invalidation` fallback path in verdict hysteresis (`hysteresis.ts:113/118`, used only when analytics S/R is null) now quotes the defended stop. Practically unreachable (analytics S/R has a candle fallback), noted for completeness.

## Validation performed

- **Unit fixtures** (`defended-stop.test.ts`): scenario-D long anchors at 48 not 52; short mirror at 52 not 48; ATR-floor-binding case unchanged; clean-alternation no-op; `atr` and `fixed-percent` methods pinned to their pure formulas; determinism (identical inputs → deep-equal plans).
- **Property tests** over 5 deterministic mock series × both directions: stop never tighter than the raw-anchored bound; `maxDollarLoss ≈ maxDollarRisk` within 1%; `rewardRisk1 ≥ 1.8`; end-to-end assertion that the R:R no-trade reason cannot fire at shipped crypto settings.
- **Diff census** (one-off script, 18 tickers × 6 timeframes × 2 directions = 216 plans on deterministic mock data): 3.2% of stops changed; width delta median 0.04 ATR, p90 0.09 ATR, max 0.09 ATR. Zero decision flips (guaranteed structurally at shipped settings, see above).
- **Full suite:** 68 tests green, lint clean, production build succeeds.

## Revisit when

- Live usage shows pathological stop widths (many ATRs) — add the width cap (alternative 5) with real distributions as evidence.
- Evidence emerges that stops _at_ the level get run by exact-touch sweeps — revisit the buffer (alternative 4) as its own decision.
- `runBacktest` is ever migrated to replay `buildRiskPlan` stops instead of its own ATR stop — re-run the win-rate/expectancy comparison this change couldn't get.
- Supply/demand zones (`zones.ts`) become the primary S/R representation — zone edges may supersede both raw pivots and leg extremes as stop anchors, retiring this distinction entirely.
- Shadow-record setup×regime stats shift anomalously after the deploy date — the pre/post population mix is the first suspect.
