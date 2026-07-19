# Trade Quality Score (TQS)

**Status:** Implemented (M9-T4, EDR 0020 decision 5). Module:
`backend/app/execution/quality_score.py`. Tests:
`backend/tests/test_execution_quality_score.py`.

## What this is — and what it is not

> **The Trade Quality Score is an evaluation of rule-compliance and setup
> quality. It is NOT a win-probability, NOT a calibrated forecast, and NOT
> an AI output.**

It is produced by a pure, deterministic function of the trade proposal, the
account's current Trading Constitution state, and a handful of already-derived
market-context values (volatility proxy, session, structure quality). Given
the same inputs, it always returns the same score — there is no model
inference, no sampling, no clock, and no network call anywhere in its
computation (`score_trade_quality` in `quality_score.py`).

Per EDR 0020 decision 5: **the AI CRO may explain the score in context, but
it never generates, adjusts, or re-weights it.** Any AI narration that quotes
a TQS must quote the deterministic value verbatim and may not present it as
a probability of the trade winning. Every render site showing a TQS must
carry the disclaimer below (or a close paraphrase) — see
`docs/score-inventory.md` for the audit of existing "confidence"-style
renders and what still needs to change to comply with this rule.

**Canonical disclaimer string** (exported as `SCORE_DISCLAIMER` in
`quality_score.py` — reuse it verbatim rather than re-typing it at each
render site):

> "Evaluation of rule-compliance and setup quality — not a win-probability."

## Scale

0–100, composed additively from six weighted components. Each component
contributes `weight * fraction`, where `fraction` is a sub-score in `[0, 1]`
computed by that component's own deterministic rule below. The total is
exactly the sum of the six components' points, so — unlike a "vibe" score —
every point is individually explainable and traceable to one rule.

| Component | Weight | What it measures |
|---|---|---|
| R:R | 25 | Proposed reward:risk vs. the constitution's configured minimum |
| Stop-placement validity | 20 | Whether the stop is anchored to real market structure, not an arbitrary distance |
| Constitution headroom | 15 | Remaining daily/weekly loss budget, position slots, and correlated-exposure room |
| Volatility vs. stop distance | 15 | Whether the stop distance is sane relative to current volatility (not noise-tight, not wastefully wide) |
| Session / liquidity | 10 | Whether the trade falls in an allowed, liquid session window |
| Behavior flags | 15 | Deterministic behavior-detector flags (revenge/overtrading/tilt) present on the account right now |

**25 + 20 + 15 + 15 + 10 + 15 = 100.** Weights are defined once, as named
constants, in `quality_score.py` (`WEIGHT_*` / `COMPONENT_WEIGHTS`) — this
table must stay in sync with that module if either changes.

## Component detail

### 1. R:R — weight 25

```
target = min_risk_reward * 2.0          # constitution's min R:R, doubled
fraction = clamp(risk_reward_ratio / target, 0, 1)
```

Hitting **2x the constitution's configured minimum R:R** earns full marks.
Below the minimum, the score falls off proportionally (a trade at exactly
the minimum R:R scores 50% of this component, since it clears the bar but
with no edge to spare). A non-positive proposed R:R scores 0.

*Input fields:* `risk_reward_ratio`, `min_risk_reward`.

### 2. Stop-placement validity vs. structure — weight 20

The stop's relationship to market structure is supplied by the caller (the
structure/POI layer, not this module — this module never inspects candles
itself) as one of four levels:

| `StopPlacementQuality` | Fraction | Meaning |
|---|---|---|
| `NONE` | 0.0 | Arbitrary distance, not anchored to any structural level |
| `WEAK` | 0.4 | Anchored, but with inadequate buffer beyond the level (wick-out risk) |
| `ADEQUATE` | 0.75 | Anchored beyond a structural level with a sane buffer |
| `STRONG` | 1.0 | Anchored beyond a strong/confirmed structural level with a sane buffer |

*Input field:* `stop_placement`.

### 3. Constitution headroom — weight 15

The average of four independent headroom fractions, each `clamp(1 - used/limit, 0, 1)`:

- daily loss budget used vs. `daily_loss_limit_percent`
- weekly loss budget used vs. `weekly_loss_limit_percent`
- concurrent positions open vs. `max_concurrent_positions`
- correlated exposure used vs. `max_correlated_exposure_percent`

If a constitution configures a limit of `0` for any of these (a valid, if
unusual, config — `validate_constitution` only requires `>= 0` for the loss
limits), that dimension is treated as "not constraining" (fraction `1.0`)
rather than guessed at or divided by zero.

*Input fields:* `daily_risk_used_percent`, `daily_loss_limit_percent`,
`weekly_risk_used_percent`, `weekly_loss_limit_percent`,
`concurrent_positions_open`, `max_concurrent_positions`,
`correlated_exposure_percent`, `max_correlated_exposure_percent`.

### 4. Volatility vs. stop distance — weight 15

```
ratio = stop_distance_percent / atr_percent
```

A "sane" stop sits between **1.0x and 2.5x** the volatility proxy (e.g. ATR%
of price) — full marks in that band. Outside it, the score decays linearly,
reaching 0 at 0.4x (far too tight — likely noise-stopped) or at 4.0x (far
too wide — inefficient risk use). A non-positive ATR% or stop distance% is
treated conservatively as 0 rather than raising, since it reflects a
market-data gap, not a programming error.

*Input fields:* `stop_distance_percent`, `atr_percent`.

### 5. Session / liquidity — weight 10

- Session is in the constitution's `allowed_sessions` **and** flagged a
  high-liquidity window → fraction `1.0`.
- Session is allowed but not flagged high-liquidity → fraction `0.6`.
- Session is not in `allowed_sessions` → fraction `0.0` (the risk engine
  would reject this trade on the same ground independently — the score
  agrees qualitatively rather than contradicting the hard gate).

*Input fields:* `session`, `allowed_sessions`, `is_high_liquidity_window`.

### 6. Behavior flags — weight 15

```
fraction = clamp(1 - len(flags_present) / len(KNOWN_BEHAVIOR_DETECTORS), 0, 1)
```

Each currently-known behavior detector present (`revenge`, `overtrading`,
`tilt` — the same `KNOWN_BEHAVIOR_DETECTORS` set the Trading Constitution's
`binding_cooldowns` draws from, imported rather than redefined) costs an
equal share of this component. This is independent of whether the
constitution made that detector *binding*: a binding detector rejects the
permit outright via the risk engine regardless of this score; this
component reflects the same signal advisorily even when it isn't binding.

*Input field:* `behavior_flags` (unknown flag names raise `ValueError` — a
caller/programming error, not a market condition).

## Composition and bounds

- `TradeQualityScore.total == sum(component.points for component in components)` —
  always, exactly (no independent rounding step that could drift the two
  apart).
- Every component's `fraction` is clamped to `[0, 1]`, so every component's
  `points` is in `[0, weight]`, and the total is always in `[0, 100]`.
- `score_trade_quality` is a pure function: same `TradeQualityInput` in,
  same `TradeQualityScore` out, verified by a determinism test that calls it
  twice (and 20x) on an identical input and asserts equality.

## What TQS deliberately does not do

- It does not estimate P(win). No backtest-derived win-rate or expectancy
  number feeds into it (that would violate EDR 0017 decision 3's evidence
  discipline, reaffirmed by EDR 0020).
- It never overrides or is overridden by the deterministic risk gate
  (`risk_engine.py` — a separate, hard pass/fail layer). A low TQS does not
  by itself reject a permit; a hard-rule violation rejects regardless of
  TQS. They are shown together on the permit card but computed independently.
- It has no AI/LLM dependency. The AI CRO layer (M9-T12) may narrate a TQS
  in its explanation of a permit, but the number and its components are
  always copied verbatim from this module's output — never generated,
  adjusted, or re-weighted by a model.
