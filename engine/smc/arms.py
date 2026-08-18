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

#: Bumped whenever an arm is added, retired or has its gate changed, and stamped
#: on every row so any observation can be traced to the registry it was taken
#: under.
#:
#: It is deliberately **not** a pooling boundary. Arms are read by name, and an
#: arm whose own definition and gate did not change is the same experiment
#: before and after a bump — segmenting it would throw away sample to record
#: that a *different* arm was edited. What must never pool is one arm's
#: observations across a change to that arm, and the mechanism for that is a
#: new name, not a new version.
ARMS_VERSION = "1.2.0"

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
# this axis was the first one filled.
#
# Both alternatives are now judged and pulled (2026-08-18), so the axis is
# empty and the trailing control stands. That is a resolved axis, not an
# abandoned one: two ways of not-trailing and of trailing-later were asked
# about, both were answered, and the control beat each. Registering a third
# exit arm is allowed and cheap — the budget is free again — but it should
# carry a hypothesis these two did not already test.

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
        retired=(
            "2026-08-18 FAIL — 470 paired, -0.077R gross against the control, "
            "Holm p=0.471, gross 95% CI [-0.219, +0.064]. The floor was met and "
            "the arm did not clear its +0.05R edge; the interval contains zero, "
            "so this is 'no effect found', not 'trailing proven better'. Only 5% "
            "of fills ever reach target, which is the mechanism: holding the "
            "structural stop mostly buys a full -1R instead of a scratch."
        ),
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
        retired=(
            "2026-08-18 RETIRE — 471 paired, -0.096R gross against the control, "
            "Holm p=0.016, gross 95% CI [-0.159, -0.033]. The interval excludes "
            "zero on the wrong side: this arm is beaten by the control, which is "
            "a stronger result than no_trail's and the one worth keeping. "
            "Giving the retracement more room does not save trades that reached "
            "1R; it gives back the part of the move the tighter trail banked."
        ),
    ),
)


def _exit_variants(primary: ForwardTestConfig) -> dict[str, ForwardTestConfig]:
    return {
        "no_trail": replace(primary, trailing_mode="NONE"),
        "wide_trail": replace(primary, trailing_activation_r=1.5, trailing_distance_r=1.5),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Axis: plan — what is fixed about the trade at detection
# ─────────────────────────────────────────────────────────────────────────────
#
# The line between this axis and `exit`, stated once because `short_hold` sits
# right on it: an **exit** arm reacts to price after the fill (trail on, off,
# wider), a **plan** arm is decided at `detected_at` and does not move. A time
# stop is a plan parameter by that test — "this thesis is void if it has not
# worked within fifteen minutes" is declared before the trade exists and is
# never revised by what price does — even though it happens to be enforced at
# the end of the trade.
#
# Two diagnosed problems, one axis, because both are answered by redrawing the
# plan rather than by changing what is detected:
#
#   * cost. The control's mean stop is 0.79% of price (SCALP) against a round
#     trip that was 0.14% and is 0.10% since generation 6 — still ~13% of the
#     stop before the detector has said anything. `wide_stop` refuses to plan a
#     stop the fees can eat.
#   * horizon. The score's information is measured, and it is short: IC +0.16 at
#     1m, +0.15 at 5m, indistinguishable from zero at 15m and beyond
#     (`research/ic-2026-08-15.md`, n=292, and the same shape in the
#     cross-sectional read). The control holds a filled setup for up to two
#     hours. `short_hold` tests whether the tail of that hold is uncompensated.
#
# `structural_swing` argued the opposite of `short_hold` and was withdrawn
# unjudged when the IC decay made its premise implausible — see its `retired`
# note. Retired arms stay here; deleting one would erase the fact that the
# question was asked.

#: The floor a `wide_stop` arm holds the invalidation to, as a percent of entry.
#: Chosen so the round trip is under a tenth of the stop: at a 0.14% round trip,
#: 1.5% of price puts cost at ~0.09R instead of ~0.21R.
WIDE_STOP_MIN_RISK_PCT = 1.5

#: How long `short_hold` gives a filled setup, in seconds. Set from the measured
#: decay of the score's information rather than from taste: the IC is +0.16 at
#: 1m and +0.15 at 5m, and indistinguishable from zero from 15m out
#: (`research/ic-2026-08-15.md`). Fifteen minutes is the first horizon at which
#: the score knows nothing, so it is the last one worth holding to.
SHORT_HOLD_SECONDS = 900.0

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
        retired=(
            "2026-08-15 WITHDRAWN — not judged. At 6/150 after two days it was "
            "accruing ~3 pairs a day and would not have reached its floor before "
            "December. It is withdrawn rather than failed: no verdict was "
            "reached and none is claimed. The reason for withdrawing it now "
            "instead of letting it run is that the score's measured IC decay "
            "(+0.16 at 1m, zero from 15m out, research/ic-2026-08-15.md) makes "
            "its premise — that a fast trigger is worth holding for up to three "
            "days — implausible enough that the slot buys more elsewhere. That "
            "is a judgement about where to spend observations, not evidence "
            "against the hypothesis, and re-registering it later is allowed."
        ),
    ),
    Arm(
        name="short_hold",
        axis="plan",
        hypothesis=(
            "The plan outlives the information it was drawn from. The score's "
            "IC is +0.16 at one minute and gone by fifteen, yet a filled setup "
            f"is held for up to two hours; capping the hold at "
            f"{int(SHORT_HOLD_SECONDS / 60)} minutes keeps the part of the move "
            "the score actually predicted and stops paying noise and fees for "
            "the part it does not."
        ),
        registered="2026-08-15",
        # Offered on every fill, like the exit arms, so it accrues at the
        # control's own rate and 400 pairs is roughly a fortnight.
        gate=Gate(min_settled=400),
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
        retired=(
            "2026-08-18 WITHDRAWN — not judged, and no verdict is claimed: at "
            "253/400 it was below its floor, where the protocol says there is "
            "no verdict at all. Its standing numbers were -0.134R gross against "
            "the control, gross 95% CI [-0.274, +0.005], Holm p=0.297.\n\n"
            "Withdrawn now rather than left to run because an independent cut "
            "makes its premise implausible. Grouping generation 5+6 SCALP rows "
            "by stop width, the band above 1.20% — where this arm forces every "
            "setup — runs +0.014R gross, against +0.167R for 0.56-0.80% and "
            "+0.148R for 0.80-1.20%. The arm's own trend and that cut point the "
            "same way, and neither says the control's floor is too tight.\n\n"
            "The reading that survives is that the record has a stop-width "
            "sweet spot around 0.56-1.20%, which is roughly where the cost "
            "floor already puts things — so the axis is better tested from a "
            "hypothesis about *which* setups earn a wide stop than by widening "
            "all of them. Re-registering is allowed if such a hypothesis "
            "arrives."
        ),
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


def settlement_variants(
    primary: ForwardTestConfig, *, active_only: bool = True
) -> tuple[Variant, ...]:
    """Every arm that runs a real paper position, as `Variant`s.

    Replaces `smc.forward_test.default_variants` as the recorder's source. The
    settlement engine is untouched: it still advances a frozen snapshot under a
    frozen config and knows nothing about axes.

    `active_only=False` includes retired arms, and exists for exactly one
    caller: settling a position that was **already open** when its arm was
    retired. Retirement stops new observations being opened, and must not
    change the rules of one already running — a `no_trail` position that
    finished under the control's trailing config would be recorded as a
    `no_trail` result while being nothing of the kind. Everything that decides
    what to open new uses the default.
    """
    exits = _exit_variants(primary)
    variants: list[Variant] = [
        Variant(arm.name, exits[arm.name])
        for arm in EXIT_ARMS
        if (arm.active or not active_only) and arm.name in exits
    ]
    for arm in PLAN_ARMS:
        if active_only and not arm.active:
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
        elif arm.name == "short_hold":
            # Config-only: the geometry is the control's, and the entry window
            # is the control's too. Shortening the wait for a fill *and* the
            # hold would confound "the setup was untradable" with "the trade
            # was closed early", and only one of those is the question.
            variants.append(
                Variant(arm.name, replace(primary, max_holding_seconds=SHORT_HOLD_SECONDS))
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
