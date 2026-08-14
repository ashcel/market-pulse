"""Competing arms, pre-registered per functionality.

The forward-test record already ran alternative exit rules alongside the
primary (`smc.forward_test.Variant`). That mechanism is right — identical
detection, identical price stream, one rule changed — and this module is that
idea stated once, generally, for every functionality worth arguing about.

An **axis** is one functionality. An **arm** is one way of doing it. Every axis
carries a control (what the live detector does today) and at most two
alternatives, because three simultaneous answers is the point where a weekly
review still has the power to separate them. `MAX_ARMS_PER_AXIS` is enforced at
import, not documented and hoped for.

Two kinds of arm, and the difference matters:

* **Settled arms** (`exit`, `plan`) run a real paper position. They cost
  settlement work per tick and are compared to the control *pairwise* — same
  setup, same tape, so the between-setup variance cancels and a difference of
  0.07R needs ~400 observations rather than ~13,000.
* **Flag arms** (`detect`) change *which* setups would exist, and so cannot be
  settled forward without running a second detector. Instead each one is a
  predicate evaluated once at detection and stamped onto the row. The weekly
  report then reads the arm as a **subset** of the same population. This costs
  nothing at runtime and, more importantly, keeps the honest property the rest
  of the record has: the flag is frozen at `detected_at` and never recomputed.

Nothing here is consulted by the live detector. An arm is evidence about a
decision, never the decision — promotion is a human act, recorded as an EDR and
a version bump, exactly as `research/arms-protocol.md` describes.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Literal

from smc.forward_test import (
    ForwardTestConfig,
    SetupSnapshot,
    Variant,
    entry_zone,
    is_finite_plan,
)

#: Bumped whenever an arm is added, retired or has its gate changed. Stamped on
#: every row so a report can never pool observations taken under two different
#: registries — the mistake that makes a weekly cadence dangerous.
ARMS_VERSION = "1.0.0"

Axis = Literal["exit", "plan", "detect"]

#: Control plus two alternatives. See the module docstring — this is a power
#: budget, not a taste.
MAX_ARMS_PER_AXIS = 3

#: The control arm's name on every axis. It is not a registered arm: it is
#: whatever the live detector already does, which is exactly what the
#: alternatives have to beat.
CONTROL = "control"


# ─────────────────────────────────────────────────────────────────────────────
# Pre-registration
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Gate:
    """The verdict rule, fixed before the data exists.

    Written down here so the weekly report *applies* a criterion rather than
    inventing one that happens to fit the week. `min_settled` is a floor, never
    a target: reaching it permits a verdict, it does not produce one.
    """

    #: Paired observations required before the arm may be judged at all. Below
    #: this the report says INSUFFICIENT and reports nothing else — no p-value,
    #: no ranking, because a ranking at n=6 is what produced the
    #: `structural_swing` mirage (t=+2.82 on a gross difference of exactly 0).
    min_settled: int
    #: The arm must beat the control by at least this much, in **gross** R per
    #: trade. Gross, because a plan-varying arm with a wider stop pays less
    #: cost per R automatically — that is arithmetic, not edge, and a net-R
    #: gate would promote it for free.
    min_gross_edge_r: float = 0.05
    #: Family-wise significance level, Holm-corrected across every arm the
    #: report tests in the same run.
    alpha: float = 0.05

    def describe(self) -> str:
        return (
            f"n>={self.min_settled} paired, gross edge >= {self.min_gross_edge_r:+.2f}R, "
            f"Holm p < {self.alpha}"
        )


@dataclass(frozen=True, slots=True)
class Arm:
    """One alternative, and the argument it exists to settle."""

    name: str
    axis: Axis
    #: What this arm claims, in one sentence, stated so it can be wrong.
    hypothesis: str
    #: ISO date the arm entered the registry. Observations before it do not
    #: exist, and the report never back-fills them.
    registered: str
    gate: Gate
    #: Set when the arm has been judged and pulled, with the date and verdict.
    #: Retired arms stay in the registry — deleting one would quietly erase the
    #: fact that a question was already asked and answered.
    retired: str = ""

    @property
    def active(self) -> bool:
        return not self.retired


# ─────────────────────────────────────────────────────────────────────────────
# Axis: exit — what to do with a position once it is filled
# ─────────────────────────────────────────────────────────────────────────────
#
# The standing evidence (2026-08-14, n=202 filled): 52% of fills reach 1R, only
# 5% reach target, trailed exits average +0.66R and stopped exits average
# -1.31R. The exit rule is therefore doing nearly all of the work, which is why
# this axis is full.

EXIT_ARMS: tuple[Arm, ...] = (
    Arm(
        name="no_trail",
        axis="exit",
        hypothesis=(
            "Holding the structural stop to target beats trailing: the trail "
            "scratches trades that would have resolved."
        ),
        registered="2026-08-13",
        gate=Gate(min_settled=400),
    ),
    Arm(
        name="wide_trail",
        axis="exit",
        hypothesis=(
            "Engaging the trail later (1.5R) and following further back (1.5R) "
            "keeps a normal retracement from scratching a trade that reached 1R."
        ),
        registered="2026-08-13",
        gate=Gate(min_settled=400),
    ),
)


def _exit_variants(primary: ForwardTestConfig) -> dict[str, ForwardTestConfig]:
    return {
        "no_trail": replace(primary, trailing_mode="NONE"),
        "wide_trail": replace(primary, trailing_activation_r=1.5, trailing_distance_r=1.5),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Axis: plan — where entry, invalidation and target are drawn
# ─────────────────────────────────────────────────────────────────────────────
#
# The diagnosed problem this axis exists for: the control's mean stop is 0.79%
# of price (SCALP) against a 0.14% round trip, so cost is 26% of the stop before
# the detector has said anything. Both arms attack that ratio, from opposite
# ends — one by re-planning against slow structure, one by refusing to plan a
# stop the fees can eat.

#: The floor a `wide_stop` arm holds the invalidation to, as a percent of entry.
#: Chosen so the round trip is under a tenth of the stop: at a 0.14% round trip,
#: 1.5% of price puts cost at ~0.09R instead of ~0.21R.
WIDE_STOP_MIN_RISK_PCT = 1.5

PLAN_ARMS: tuple[Arm, ...] = (
    Arm(
        name="structural_swing",
        axis="plan",
        hypothesis=(
            "The fast lane is better used as a trigger for a slow 4H/1H "
            "structural hold than as a trade in its own right."
        ),
        registered="2026-08-13",
        # Rarely offered — slow structure has a plan for a fraction of fast
        # events — so the floor is lower, and the report will simply keep
        # saying INSUFFICIENT until it is met. That is the correct output.
        gate=Gate(min_settled=150),
    ),
    Arm(
        name="wide_stop",
        axis="plan",
        hypothesis=(
            "The control's edge is real but sub-cost: at a stop of 0.79% of "
            "price the round trip is 26% of R. Holding the same detection to a "
            f"{WIDE_STOP_MIN_RISK_PCT}% minimum stop — worse nominal RR, far "
            "less cost drag — nets more per trade."
        ),
        registered="2026-08-14",
        gate=Gate(min_settled=400),
    ),
)


def widened_plan(
    snapshot: SetupSnapshot,
    config: ForwardTestConfig,
    min_risk_pct: float = WIDE_STOP_MIN_RISK_PCT,
) -> SetupSnapshot | None:
    """The same detection, held to a minimum stop distance.

    Pure geometry over values already frozen at `detected_at` — no new data, no
    refetch, so this inherits the no-lookahead guarantee of the snapshot it is
    derived from. The target is deliberately **left where it was**: the whole
    question is whether surviving the noise is worth the worse nominal RR, and
    moving the target too would answer a different, easier one.

    `None` when the control's stop already clears the floor, which is the
    honest answer — there is no alternative to record, and recording the
    control's own geometry under this arm's name would dilute the comparison
    with identical rows.
    """
    entry = snapshot.reference_entry
    if entry <= 0:
        return None
    floor = entry * min_risk_pct / 100.0
    risk = abs(entry - snapshot.initial_invalidation)
    if risk >= floor:
        return None
    invalidation = entry - floor if snapshot.direction == "bullish" else entry + floor
    if not is_finite_plan(entry, invalidation, snapshot.target):
        return None
    low, high = entry_zone(snapshot.direction, entry, invalidation, config)
    reward = abs(snapshot.target - entry)
    return replace(
        snapshot,
        entry_low=low,
        entry_high=high,
        initial_invalidation=invalidation,
        potential_rr=reward / floor,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Axis: detect — which situations become setups at all
# ─────────────────────────────────────────────────────────────────────────────
#
# Flags, not settled positions. Each predicate reads only the frozen snapshot,
# runs once at detection, and is stored; the report reads it as a subset. A
# detector arm can therefore never be "run" in production by accident — there
# is nothing to run.

DETECT_ARMS: tuple[Arm, ...] = (
    Arm(
        name="displacement_only",
        axis="detect",
        hypothesis=(
            "Only displacement+participation setups carry the edge: they ran "
            "+0.00R/trade against -0.25R for structure+activity over the first "
            "205 setups, the widest split in the record."
        ),
        registered="2026-08-14",
        # Unpaired subset comparison, so it needs far more than a paired arm.
        gate=Gate(min_settled=600),
    ),
    Arm(
        name="htf_aligned",
        axis="detect",
        hypothesis=(
            "Higher-timeframe agreement is worth acting on rather than only "
            "recording: setups whose direction matches the HTF bias outperform "
            "the rest of the population."
        ),
        registered="2026-08-14",
        gate=Gate(min_settled=600),
    ),
)

#: Predicates over the frozen snapshot. Deliberately dull and total — a
#: predicate that can raise would take the recorder down for a research
#: question, which is never the right trade.
_DETECT_PREDICATES: dict[str, Callable[[SetupSnapshot], bool]] = {
    "displacement_only": lambda s: "displacement" in s.combo and "participation" in s.combo,
    "htf_aligned": lambda s: (
        (s.direction == "bullish" and s.htf_bias == "bullish")
        or (s.direction == "bearish" and s.htf_bias == "bearish")
    ),
}


# ─────────────────────────────────────────────────────────────────────────────
# Registry
# ─────────────────────────────────────────────────────────────────────────────

ARMS: tuple[Arm, ...] = EXIT_ARMS + PLAN_ARMS + DETECT_ARMS


def _validate() -> None:
    """Enforced at import: the budget is the mechanism, not a note."""
    per_axis = Counter(arm.axis for arm in ARMS if arm.active)
    for axis, count in per_axis.items():
        # +1 for the control, which is never a registered arm.
        if count + 1 > MAX_ARMS_PER_AXIS:
            raise ValueError(
                f"axis {axis!r} has {count + 1} active arms including the control; "
                f"MAX_ARMS_PER_AXIS is {MAX_ARMS_PER_AXIS}. Retire one before "
                f"registering another."
            )
    names = [arm.name for arm in ARMS]
    if len(names) != len(set(names)):
        raise ValueError("arm names must be unique across all axes")
    missing = {a.name for a in DETECT_ARMS if a.active} - set(_DETECT_PREDICATES)
    if missing:
        raise ValueError(f"detector arms without a predicate: {sorted(missing)}")


_validate()


def arms_on(axis: Axis, *, active_only: bool = True) -> tuple[Arm, ...]:
    return tuple(a for a in ARMS if a.axis == axis and (a.active or not active_only))


def arm_named(name: str) -> Arm | None:
    for arm in ARMS:
        if arm.name == name:
            return arm
    return None


def settlement_variants(primary: ForwardTestConfig) -> tuple[Variant, ...]:
    """Every arm that runs a real paper position, as `Variant`s.

    Replaces `smc.forward_test.default_variants` as the recorder's source. The
    settlement engine is untouched: it still advances a frozen snapshot under a
    frozen config and knows nothing about axes.
    """
    exits = _exit_variants(primary)
    variants: list[Variant] = [
        Variant(arm.name, exits[arm.name])
        for arm in EXIT_ARMS
        if arm.active and arm.name in exits
    ]
    for arm in PLAN_ARMS:
        if not arm.active:
            continue
        if arm.name == "structural_swing":
            variants.append(
                Variant(
                    arm.name,
                    replace(
                        primary,
                        entry_window_seconds=14_400.0,
                        max_holding_seconds=259_200.0,
                    ),
                    varies_plan=True,
                )
            )
        elif arm.name == "wide_stop":
            # Same horizon as the control — the only thing that varies is where
            # the stop sits. A wider stop *and* a longer leash would confound
            # the two, and neither would then be answerable.
            variants.append(Variant(arm.name, primary, varies_plan=True))
    return tuple(variants)


def detector_flags(snapshot: SetupSnapshot) -> dict[str, bool]:
    """Which detector arms would have taken this setup. Stamped, never read by
    the detector. A predicate that raises is recorded as `False` rather than
    killing the capture — the research question is not worth the tick."""
    flags: dict[str, bool] = {}
    for arm in DETECT_ARMS:
        if not arm.active:
            continue
        predicate = _DETECT_PREDICATES.get(arm.name)
        if predicate is None:
            continue
        try:
            flags[arm.name] = bool(predicate(snapshot))
        except Exception:  # pragma: no cover — defensive by intent
            flags[arm.name] = False
    return flags


def arm_flag_values(snapshot: SetupSnapshot) -> dict[str, object]:
    """The `arm_flags` column: the detector-arm verdicts plus the registry
    version they were taken under, so two registries never pool."""
    return {"version": ARMS_VERSION, "detect": detector_flags(snapshot)}
