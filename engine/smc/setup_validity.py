"""Setup validity check against the **live** price.

The engine core (intent/hysteresis) grades setups from the last *closed*
bar's ``last_close`` — correct for record grading. But a plan built when
price was sitting on support can stay displayed as "favored" long after price
has run past the entry zone into negative R:R. This pure function is the
UI-layer gate that suppresses stale/invalidated setups.

Two severity levels:

- **invalidated** — live price has already touched or passed the stop. The
  setup is dead; no position should be entered at any price.
- **stale** — the setup's geometry no longer pays at the live price: R:R is
  zero/negative, price has chased far past the entry zone, or price has
  already reached the first target.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

SetupValiditySeverity = Literal["valid", "invalidated", "stale"]


@dataclass(slots=True)
class SetupValidityResult:
    valid: bool
    severity: SetupValiditySeverity
    reason: str | None = None


@dataclass(slots=True)
class SetupValidityPlan:
    """The plan shape this function needs — a structural subset of RiskRewardPlan."""

    direction: Literal["long", "short"]
    entry: float
    entry_low: float
    entry_high: float
    stop: float
    target1: float
    target2: float


# How far past the entry zone price may travel (in risk units) before the
# setup is considered stale. 2x means "price has moved twice the initial risk
# past the zone edge" — far enough that the original entry geometry is
# meaningless, but not so far that it's necessarily an invalidation.
_STALE_DISTANCE_RISK_MULTIPLE = 2


def validate_setup_freshness(plan: SetupValidityPlan, live_price: float) -> SetupValidityResult:
    """Returns the validity of a plan against the live price. Bad data (NaN,
    zero, infinity, non-finite plan levels) returns valid — when we can't
    assess freshness we don't block, because the rest of the engine already
    gates on having a real plan."""
    # Guard: bad price data — don't block on garbage.
    if not math.isfinite(live_price) or live_price <= 0:
        return SetupValidityResult(valid=True, severity="valid")

    # Guard: bad plan data — don't block on garbage.
    if not all(
        math.isfinite(v)
        for v in (plan.entry, plan.stop, plan.target1, plan.entry_low, plan.entry_high)
    ):
        return SetupValidityResult(valid=True, severity="valid")

    long = plan.direction == "long"
    risk_per_unit = abs(plan.entry - plan.stop)

    # Guard: degenerate plan — no risk means no meaningful geometry.
    if risk_per_unit <= 0:
        return SetupValidityResult(valid=True, severity="valid")

    # ── Level 1: Invalidated — price already touched stop ──────────────────
    if live_price <= plan.stop if long else live_price >= plan.stop:
        return SetupValidityResult(
            valid=False,
            severity="invalidated",
            reason="Price has reached the stop level — the setup is invalidated.",
        )

    # ── Level 2a: Price already at/past target1 — no room to target ────────
    if live_price >= plan.target1 if long else live_price <= plan.target1:
        return SetupValidityResult(
            valid=False,
            severity="stale",
            reason="Price has already reached the first target — this plan is no longer "
            "executable.",
        )

    # ── Level 2b: Negative R:R at live price ───────────────────────────────
    reward = plan.target1 - live_price if long else live_price - plan.target1
    risk = live_price - plan.stop if long else plan.stop - live_price
    if risk <= 0 or reward / risk <= 0:
        return SetupValidityResult(
            valid=False,
            severity="stale",
            reason="Reward-to-risk is zero or negative at the current price.",
        )

    # ── Level 2c: Price chased too far past the entry zone ─────────────────
    stale_distance = _STALE_DISTANCE_RISK_MULTIPLE * risk_per_unit
    chased = (
        live_price > plan.entry_high + stale_distance
        if long
        else live_price < plan.entry_low - stale_distance
    )
    if chased:
        return SetupValidityResult(
            valid=False,
            severity="stale",
            reason="Price has moved well past the entry zone — the setup is stale.",
        )

    return SetupValidityResult(valid=True, severity="valid")
