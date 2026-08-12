"""PULLBACK DETECTOR + COMPLETION EVIDENCE.

What these pin:

* a retracement is measured against its own impulse leg, not in raw percent;
* one opposite tick is not a pullback, and a broken origin is not one either;
* health is a description, never a gate;
* completion is an evidence *list*, and LIKELY additionally needs something to
  have actually happened rather than the tape merely going quiet;
* bullish and bearish tape produce identical reads.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from smc.pullback import (
    DEFAULT_PULLBACK_CONFIG,
    ImpulseLeg,
    read_pullback,
    retrace_fraction,
)
from smc.pullback_completion import DEFAULT_COMPLETION_CONFIG, read_completion
from smc.structure_map import StructuralLevel

CFG = DEFAULT_PULLBACK_CONFIG
COMPLETION = DEFAULT_COMPLETION_CONFIG
T0 = 1_700_000_000.0

# A 10% bullish leg from 100 to 110, and its mirror.
BULL = ImpulseLeg(direction="bullish", origin=100.0, extreme=110.0, started_at=T0)
BEAR = ImpulseLeg(direction="bearish", origin=110.0, extreme=100.0, started_at=T0)


def level(price: float, kind: str = "swing_low", timeframe: str = "5M") -> StructuralLevel:
    return StructuralLevel(price=price, kind=kind, timeframe=timeframe, time=int(T0))  # type: ignore[arg-type]


def read(leg: ImpulseLeg, price: float, **kwargs: object):
    extreme = kwargs.pop("pullback_extreme", price)
    return read_pullback(
        leg,
        price,
        pullback_extreme=extreme,  # type: ignore[arg-type]
        now=kwargs.pop("now", T0 + 60),  # type: ignore[arg-type]
        config=CFG,
        **kwargs,  # type: ignore[arg-type]
    )


# ── depth is relative to the leg ─────────────────────────────────────────────


def test_retracement_is_a_fraction_of_the_impulse_not_a_raw_percentage() -> None:
    """1% back on a 10% leg is a pause; the same 1% on a 2% leg is half of it."""
    small_leg = ImpulseLeg(direction="bullish", origin=100.0, extreme=102.0, started_at=T0)
    assert retrace_fraction(BULL, 109.0) == pytest.approx(0.10)
    assert retrace_fraction(small_leg, 101.0) == pytest.approx(0.50)


def test_a_shallow_tick_against_the_move_is_not_a_pullback() -> None:
    assert read(BULL, 109.5).state == "NONE"


def test_a_material_retracement_is() -> None:
    result = read(BULL, 107.0)
    assert result.state == "PULLBACK"
    assert result.retrace_frac == pytest.approx(0.30)
    assert result.structure_intact is True


def test_an_excessive_retracement_reads_deep_but_still_alive() -> None:
    result = read(BULL, 102.0)
    assert result.state == "DEEP"
    assert result.structure_intact is True


def test_trading_through_the_origin_breaks_the_leg() -> None:
    result = read(BULL, 99.0)
    assert result.state == "BROKEN"
    assert result.structure_intact is False
    assert result.is_active is False


def test_depth_uses_the_deepest_point_not_just_the_last_price() -> None:
    """Price bounced back, but the retracement still went where it went."""
    result = read(BULL, 108.0, pullback_extreme=102.0)
    assert result.retrace_frac == pytest.approx(0.80)
    assert result.state == "DEEP"


def test_a_degenerate_leg_never_divides_by_zero() -> None:
    flat = ImpulseLeg(direction="bullish", origin=100.0, extreme=100.0, started_at=T0)
    assert read(flat, 100.0).retrace_frac == 0.0


# ── health is descriptive ────────────────────────────────────────────────────


def test_a_cooling_controlled_retracement_reads_healthy() -> None:
    result = read(BULL, 107.0, volume_ratio=0.7)
    assert result.is_healthy is True


def test_a_retracement_on_rising_volume_is_still_a_pullback_just_not_healthy() -> None:
    result = read(BULL, 107.0, volume_ratio=2.4)
    assert result.state == "PULLBACK"
    assert result.is_healthy is False


def test_duration_counts_from_when_the_caller_says_it_started() -> None:
    result = read(BULL, 107.0, started_at=T0 + 30, now=T0 + 90)
    assert result.duration_seconds == pytest.approx(60.0)


# ── structural location ──────────────────────────────────────────────────────


def test_price_sitting_on_a_level_is_reported() -> None:
    result = read(BULL, 107.0, levels=(level(107.1),))
    assert result.at_level is not None
    assert result.at_level.timeframe == "5M"
    assert result.distance_to_level_pct is not None


def test_a_level_far_away_is_not_reported_as_reached() -> None:
    result = read(BULL, 107.0, levels=(level(101.0),))
    assert result.at_level is None


# ── symmetry ─────────────────────────────────────────────────────────────────


def test_bullish_and_bearish_retracements_are_mirrors() -> None:
    bull = read(BULL, 107.0, volume_ratio=0.8)
    bear = read(BEAR, 103.0, volume_ratio=0.8)
    assert bull.state == bear.state
    assert bull.retrace_frac == pytest.approx(bear.retrace_frac)
    assert bull.is_healthy == bear.is_healthy


# ── completion evidence ──────────────────────────────────────────────────────


def complete(pullback, **kwargs: object):
    base: dict[str, object] = dict(
        directional_move_pct=0.0,
        directional_rvol=1.0,
        micro_choch=False,
        liquidity_swept=False,
    )
    base.update(kwargs)
    return read_completion(pullback, config=COMPLETION, **base)  # type: ignore[arg-type]


def test_a_quiet_controlled_pullback_produces_partial_evidence() -> None:
    result = complete(read(BULL, 107.0, volume_ratio=0.8))
    codes = {item.code for item in result.met}
    assert "VOLUME_COOLED" in codes
    assert "RETRACEMENT_CONTROLLED" in codes
    assert result.state in ("FORMING", "DEVELOPING")


def test_volume_cooling_is_reported_with_its_reading() -> None:
    result = complete(read(BULL, 107.0, volume_ratio=0.8))
    cooled = next(item for item in result.evidence if item.code == "VOLUME_COOLED")
    assert cooled.met is True
    assert cooled.detail == "0.8x"


def test_volume_re_expansion_is_its_own_separate_evidence() -> None:
    quiet = complete(read(BULL, 107.0, volume_ratio=0.8), directional_rvol=1.0)
    loud = complete(read(BULL, 107.0, volume_ratio=0.8), directional_rvol=2.2)
    assert {i.code for i in quiet.met} | {"VOLUME_REEXPANDING"} == {i.code for i in loud.met}


def test_a_dead_tape_never_reaches_likely_however_much_evidence_it_gathers() -> None:
    """Six ways of saying "it went quiet" is not a resumption. LIKELY needs
    something to have actually happened."""
    result = complete(
        read(BULL, 107.0, volume_ratio=0.5, levels=(level(107.05),)),
        directional_move_pct=0.0,
        directional_rvol=0.4,
    )
    assert result.has_trigger is False
    assert result.state != "LIKELY"


def test_a_trigger_plus_supporting_evidence_reaches_likely() -> None:
    result = complete(
        read(BULL, 107.0, volume_ratio=0.6, levels=(level(107.05),)),
        directional_move_pct=0.6,
        directional_rvol=2.0,
        micro_choch=True,
        liquidity_swept=True,
    )
    assert result.has_trigger is True
    assert result.met_count >= COMPLETION.likely_min
    assert result.state == "LIKELY"


def test_evidence_is_always_reported_in_full_including_what_failed() -> None:
    """The card shows the checklist, so the misses have to travel too."""
    result = complete(read(BULL, 107.0, volume_ratio=3.0))
    assert len(result.evidence) == 8
    assert any(item.met is False for item in result.evidence)


def test_completion_evidence_is_symmetric() -> None:
    bull = complete(
        read(BULL, 107.0, volume_ratio=0.6),
        directional_move_pct=0.6,
        directional_rvol=2.0,
        micro_choch=True,
    )
    bear = complete(
        read(BEAR, 103.0, volume_ratio=0.6),
        directional_move_pct=0.6,
        directional_rvol=2.0,
        micro_choch=True,
    )
    assert bull.state == bear.state
    assert [i.code for i in bull.met] == [i.code for i in bear.met]


def test_a_mode_can_demand_more_evidence_before_calling_it() -> None:
    strict = replace(COMPLETION, likely_min=7)
    # Six of the eight items fire: enough for the default bar, not the strict one.
    pullback = read(BULL, 107.0, volume_ratio=3.0, levels=(level(107.05),))
    shared: dict[str, object] = dict(
        directional_move_pct=0.6,
        directional_rvol=2.0,
        micro_choch=True,
        liquidity_swept=False,
    )
    lenient = read_completion(pullback, config=COMPLETION, **shared)  # type: ignore[arg-type]
    demanding = read_completion(pullback, config=strict, **shared)  # type: ignore[arg-type]
    assert lenient.met_count == 6
    assert lenient.state == "LIKELY"
    assert demanding.state == "DEVELOPING"
