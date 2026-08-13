"""SWING PLAN — the fast detection re-planned against slow structure.

What has to hold:

* the invalidation is the *nearest* slow level behind entry, never a
  conveniently distant one;
* no structure behind, nothing ahead, or too short a path means no plan —
  never an invented percentage;
* the resulting stop is wider than the fast one, which is the entire
  arithmetic argument for the variant;
* bullish and bearish are mirrors.
"""

from __future__ import annotations

import pytest

from smc.scan_profiles import profile_for
from smc.structure_map import StructuralLevel, StructureMap
from smc.swing_plan import structural_anchor, swing_plan

T0 = 1_700_000_000
SWING = profile_for("SWING").path


def level(price: float, kind: str = "swing_low", timeframe: str = "4H") -> StructuralLevel:
    return StructuralLevel(price=price, kind=kind, timeframe=timeframe, time=T0, touches=1)


def smap(
    timeframe: str = "4H",
    highs: tuple[StructuralLevel, ...] = (),
    lows: tuple[StructuralLevel, ...] = (),
) -> StructureMap:
    return StructureMap(
        timeframe=timeframe,
        trend="range",
        event=None,
        event_label=None,
        event_time=T0,
        highs=highs,
        lows=lows,
        last_close=100.0,
        bars=200,
        computed_at=float(T0),
    )


# ── the anchor ───────────────────────────────────────────────────────────────


def test_the_anchor_is_the_nearest_level_behind_price() -> None:
    """A distant anchor would buy a wider stop by ignoring the structure in
    between — the same self-flattery as a stop inside the noise band."""
    maps = (smap(lows=(level(90.0), level(97.0), level(80.0))),)
    assert structural_anchor("bullish", 100.0, maps) == pytest.approx(97.0)


def test_levels_ahead_of_price_are_not_anchors() -> None:
    maps = (smap(lows=(level(103.0), level(96.0))),)
    assert structural_anchor("bullish", 100.0, maps) == pytest.approx(96.0)


def test_the_anchor_is_mirrored() -> None:
    below = (smap(lows=(level(96.0),)),)
    above = (smap(highs=(level(104.0, kind="swing_high"),)),)
    assert 100.0 - structural_anchor("bullish", 100.0, below) == pytest.approx(
        structural_anchor("bearish", 100.0, above) - 100.0
    )


def test_no_structure_behind_price_has_no_anchor() -> None:
    assert structural_anchor("bullish", 100.0, (smap(lows=(level(105.0),)),)) is None
    assert structural_anchor("bullish", 100.0, ()) is None


def test_anchors_are_taken_across_every_timeframe_offered() -> None:
    maps = (smap("4H", lows=(level(90.0),)), smap("1H", lows=(level(98.0, timeframe="1H"),)))
    assert structural_anchor("bullish", 100.0, maps) == pytest.approx(98.0)


# ── the plan ─────────────────────────────────────────────────────────────────


def test_a_plan_needs_structure_on_both_sides() -> None:
    only_behind = (smap(lows=(level(96.0),)),)
    assert swing_plan("bullish", 100.0, only_behind, config=SWING) is None
    only_ahead = (smap(highs=(level(108.0, kind="swing_high"),)),)
    assert swing_plan("bullish", 100.0, only_ahead, config=SWING) is None
    assert swing_plan("bullish", 100.0, (), config=SWING) is None


def test_a_plan_spans_the_anchor_and_the_level_ahead() -> None:
    maps = (
        smap(
            lows=(level(96.0),),
            highs=(level(112.0, kind="equal_highs"),),
        ),
    )
    path = swing_plan("bullish", 100.0, maps, config=SWING)
    assert path is not None
    assert path.invalidation < 96.0  # beyond the anchor, not exactly on it
    assert path.target == pytest.approx(112.0)
    assert path.entry == pytest.approx(100.0)


def test_the_swing_stop_clears_the_swing_floor() -> None:
    """The whole arithmetic argument: cost is round_trip / risk_pct."""
    maps = (smap(lows=(level(99.98),), highs=(level(112.0, kind="equal_highs"),)),)
    path = swing_plan("bullish", 100.0, maps, config=SWING)
    assert path is not None
    assert path.risk_pct >= SWING.min_risk_pct
    # …and at that width the round trip is a rounding error, not the trade.
    assert SWING.round_trip_cost_pct / path.risk_pct <= SWING.max_cost_r


def test_a_path_with_no_room_is_rejected_rather_than_stretched() -> None:
    maps = (smap(lows=(level(90.0),), highs=(level(100.4, kind="equal_highs"),)),)
    path = swing_plan("bullish", 100.0, maps, config=SWING)
    assert path is None or path.verdict == "SKIP"


def test_the_plan_is_mirrored() -> None:
    up = swing_plan(
        "bullish",
        100.0,
        (smap(lows=(level(96.0),), highs=(level(112.0, kind="equal_highs"),)),),
        config=SWING,
    )
    down = swing_plan(
        "bearish",
        100.0,
        (smap(highs=(level(104.0, kind="swing_high"),), lows=(level(88.0, kind="equal_lows"),)),),
        config=SWING,
    )
    assert up is not None and down is not None
    assert up.reward == pytest.approx(down.reward)
    # Risk mirrors only to within the buffer's own anchoring: the percentage
    # floor in `invalidation_price` is taken against the *anchor* price, and a
    # level 4 below entry is a smaller number than one 4 above, so the two
    # buffers differ by that ratio (5.44 vs 5.56 here). Pre-existing, bounded
    # by the anchor distance, and it never changes the sign of anything — but
    # it is an asymmetry, so it is pinned rather than assumed away.
    assert up.risk == pytest.approx(down.risk, rel=0.03)
    assert up.rr == pytest.approx(down.rr, rel=0.03)
