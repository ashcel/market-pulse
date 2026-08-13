"""LIQUIDITY TARGETS + STRUCTURAL PATH + STRUCTURE MAP.

The chain that answers "where could this go, and is the geometry worth
anything":

* a target is a level the market already reacted to, never a fixed percentage;
* liquidity pools outrank lone swings, and higher timeframes outrank lower;
* a sweep requires both taking the level *and* giving it back;
* R is a filter — a short path is rejected — and never a promise;
* bullish and bearish are mirrors throughout.
"""

from __future__ import annotations

import math

import pytest

from smc.liquidity_targets import DEFAULT_TARGET_CONFIG, detect_sweep, select_targets
from smc.structural_path import (
    DEFAULT_PATH_CONFIG,
    PathConfig,
    build_path,
    invalidation_price,
    risk_floor_pct,
)
from smc.structure_map import StructuralLevel, StructureMap, build_structure_map
from smc.types import Candle

T0 = 1_700_000_000
CFG = DEFAULT_TARGET_CONFIG
PATH = DEFAULT_PATH_CONFIG


def level(
    price: float, kind: str = "swing_low", timeframe: str = "5M", touches: int = 1
) -> StructuralLevel:
    return StructuralLevel(
        price=price,
        kind=kind,  # type: ignore[arg-type]
        timeframe=timeframe,
        time=T0,
        touches=touches,
    )


def structure_map(
    timeframe: str = "5M",
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
        bars=120,
        computed_at=float(T0),
    )


# ── structure map ────────────────────────────────────────────────────────────


def test_a_map_reduces_a_series_to_its_swings() -> None:
    candles = [
        Candle(
            time=T0 + index * 300,
            open=100.0,
            high=100.0 + 2.0 * math.sin(2 * math.pi * index / 12) + 0.5,
            low=100.0 + 2.0 * math.sin(2 * math.pi * index / 12) - 0.5,
            close=100.0 + 2.0 * math.sin(2 * math.pi * index / 12),
            volume=1_000.0,
        )
        for index in range(80)
    ]
    result = build_structure_map("5M", candles, float(T0))
    assert result is not None
    assert result.highs and result.lows
    assert result.last_high is not None and result.last_low is not None
    assert result.last_high.price > result.last_low.price


def test_a_map_needs_enough_history() -> None:
    thin = [
        Candle(time=T0 + i * 300, open=1.0, high=1.1, low=0.9, close=1.0, volume=1.0)
        for i in range(10)
    ]
    assert build_structure_map("5M", thin, float(T0)) is None


def test_equal_levels_are_flagged_as_liquidity() -> None:
    assert level(100.0, kind="equal_lows").is_liquidity is True
    assert level(100.0, kind="swing_low").is_liquidity is False


# ── target selection ─────────────────────────────────────────────────────────


def test_targets_are_levels_ahead_of_price() -> None:
    maps = (structure_map(lows=(level(97.0), level(103.0))),)
    targets = select_targets(maps, "bearish", 100.0, CFG)
    assert [t.price for t in targets] == [97.0]


def test_the_nearest_destination_comes_first() -> None:
    maps = (structure_map(lows=(level(94.0), level(98.0), level(90.0))),)
    targets = select_targets(maps, "bearish", 100.0, CFG)
    assert [t.price for t in targets] == [98.0, 94.0, 90.0]


def test_resting_liquidity_outranks_a_lone_swing_at_a_similar_distance() -> None:
    maps = (
        structure_map(
            lows=(level(97.5), level(97.0, kind="equal_lows", touches=3)),
        ),
    )
    targets = select_targets(maps, "bearish", 100.0, CFG)
    assert targets[0].level.kind == "equal_lows"


def test_a_level_inside_the_noise_band_is_not_a_destination() -> None:
    maps = (structure_map(lows=(level(99.9),)),)
    assert select_targets(maps, "bearish", 100.0, CFG) == ()


def test_a_level_on_a_different_timeframe_entirely_is_ignored() -> None:
    maps = (structure_map(lows=(level(50.0),)),)
    assert select_targets(maps, "bearish", 100.0, CFG) == ()


def test_no_structure_means_no_target_rather_than_an_invented_one() -> None:
    assert select_targets((), "bearish", 100.0, CFG) == ()


def test_target_selection_is_symmetric() -> None:
    bearish = select_targets((structure_map(lows=(level(96.0),)),), "bearish", 100.0, CFG)
    bullish = select_targets(
        (structure_map(highs=(level(104.0, kind="swing_high"),)),), "bullish", 100.0, CFG
    )
    assert bearish[0].distance_pct == pytest.approx(bullish[0].distance_pct)


# ── sweeps ───────────────────────────────────────────────────────────────────


def test_a_sweep_needs_the_level_taken_and_given_back() -> None:
    maps = (structure_map(highs=(level(102.0, kind="equal_highs", touches=2),)),)
    # Retracement poked above 102 and price is back below it.
    assert detect_sweep(maps, "bearish", pullback_extreme=102.5, price=101.0) is not None
    # Still above the level: that is a breakout, not a sweep.
    assert detect_sweep(maps, "bearish", pullback_extreme=102.5, price=102.4) is None
    # Never reached it.
    assert detect_sweep(maps, "bearish", pullback_extreme=101.5, price=101.0) is None


def test_only_resting_liquidity_can_be_swept() -> None:
    maps = (structure_map(highs=(level(102.0, kind="swing_high"),)),)
    assert detect_sweep(maps, "bearish", pullback_extreme=102.5, price=101.0) is None


def test_sweeps_are_symmetric() -> None:
    above = (structure_map(highs=(level(102.0, kind="equal_highs", touches=2),)),)
    below = (structure_map(lows=(level(98.0, kind="equal_lows", touches=2),)),)
    assert detect_sweep(above, "bearish", 102.5, 101.0) is not None
    assert detect_sweep(below, "bullish", 97.5, 99.0) is not None


# ── the path ─────────────────────────────────────────────────────────────────


def test_invalidation_sits_beyond_the_pullback_extreme() -> None:
    bearish = invalidation_price("bearish", pullback_extreme=101.0, leg_size=10.0, config=PATH)
    bullish = invalidation_price("bullish", pullback_extreme=99.0, leg_size=10.0, config=PATH)
    assert bearish > 101.0
    assert bullish < 99.0


def test_the_buffer_scales_with_the_impulse() -> None:
    small = invalidation_price("bearish", 101.0, leg_size=2.0, config=PATH)
    large = invalidation_price("bearish", 101.0, leg_size=20.0, config=PATH)
    assert large > small


def test_a_long_path_against_a_tight_stop_is_worth_watching() -> None:
    path = build_path(
        "bearish",
        entry=100.0,
        pullback_extreme=100.5,
        leg_size=5.0,
        target=94.0,
        target_kind="equal_lows",
        config=PATH,
    )
    assert path is not None
    assert path.rr > PATH.good_rr
    assert path.verdict == "WORTH_WATCHING"
    assert path.is_worth_watching is True


def test_a_short_path_is_rejected() -> None:
    """R is a filter. A target inside the stop distance is not an opportunity,
    however exciting the event that produced it was."""
    path = build_path(
        "bearish", entry=100.0, pullback_extreme=101.0, leg_size=5.0, target=99.5, config=PATH
    )
    assert path is not None
    assert path.rr < PATH.min_rr
    assert path.verdict == "SKIP"
    assert path.is_worth_watching is False


def test_a_middling_path_reads_thin_rather_than_good() -> None:
    path = build_path(
        "bearish", entry=100.0, pullback_extreme=100.4, leg_size=4.0, target=98.0, config=PATH
    )
    assert path is not None
    assert PATH.min_rr <= path.rr < PATH.good_rr
    assert path.verdict == "THIN"


def test_a_target_on_the_wrong_side_of_entry_is_not_a_path() -> None:
    assert (
        build_path(
            "bearish", entry=100.0, pullback_extreme=101.0, leg_size=5.0, target=104.0, config=PATH
        )
        is None
    )


def test_a_degenerate_geometry_is_not_a_path() -> None:
    assert (
        build_path(
            "bearish", entry=100.0, pullback_extreme=101.0, leg_size=5.0, target=100.0, config=PATH
        )
        is None
    )


def test_the_path_is_symmetric() -> None:
    bearish = build_path(
        "bearish", entry=100.0, pullback_extreme=100.5, leg_size=5.0, target=94.0, config=PATH
    )
    bullish = build_path(
        "bullish", entry=100.0, pullback_extreme=99.5, leg_size=5.0, target=106.0, config=PATH
    )
    assert bearish is not None and bullish is not None
    assert bearish.rr == pytest.approx(bullish.rr)
    assert bearish.verdict == bullish.verdict
    assert bearish.risk_pct == pytest.approx(bullish.risk_pct)


def test_a_mode_can_demand_a_longer_path() -> None:
    from dataclasses import replace

    strict = replace(PATH, min_rr=6.0, good_rr=8.0)
    path = build_path(
        "bearish", entry=100.0, pullback_extreme=100.5, leg_size=5.0, target=94.0, config=strict
    )
    assert path is not None
    assert path.verdict == "SKIP"


# ── the volatility floor ─────────────────────────────────────────────────────


def test_a_stop_inside_the_noise_band_is_widened_to_clear_it() -> None:
    """The defect the first forward-test cohort exposed: a structurally correct
    stop that sits inside the symbol's own 1m range is settled by noise, not by
    the thesis."""
    tight = invalidation_price("bearish", 100.0, leg_size=1.0, config=PATH)
    floored = invalidation_price(
        "bearish", 100.0, leg_size=1.0, config=PATH, volatility_pct=0.8
    )
    assert floored > tight
    # 1.5 x a 0.8% range = 1.2%, which is the binding floor here.
    assert floored == pytest.approx(100.0 * (1 + 0.012), rel=1e-6)


def test_a_wide_structural_stop_is_left_alone() -> None:
    """The floor is a minimum, not a target: real structure still wins."""
    wide = invalidation_price("bearish", 100.0, leg_size=40.0, config=PATH)
    with_volatility = invalidation_price(
        "bearish", 100.0, leg_size=40.0, config=PATH, volatility_pct=0.2
    )
    assert wide == with_volatility


def test_widening_the_stop_lowers_r_instead_of_raising_it() -> None:
    """The adverse-selection loop, closed. Before the floor, a thinner stop
    produced a *higher* ratio, so an `min_rr` gate preferentially selected the
    most fragile geometry."""
    noisy = build_path(
        "bearish",
        entry=100.0,
        pullback_extreme=100.1,
        leg_size=1.0,
        target=94.0,
        config=PATH,
        volatility_pct=1.0,
    )
    ignored = build_path(
        "bearish", entry=100.0, pullback_extreme=100.1, leg_size=1.0, target=94.0, config=PATH
    )
    assert noisy is not None and ignored is not None
    assert noisy.rr < ignored.rr
    assert noisy.risk_pct > ignored.risk_pct


def test_a_headline_ratio_built_on_a_sub_noise_stop_no_longer_survives() -> None:
    """STORJ's recorded 14.1R came from a 0.58% stop on a volatile symbol. With
    the floor, that same geometry reads as the thin path it always was."""
    inflated = build_path(
        "bearish", entry=100.0, pullback_extreme=100.05, leg_size=0.5, target=92.0, config=PATH
    )
    honest = build_path(
        "bearish",
        entry=100.0,
        pullback_extreme=100.05,
        leg_size=0.5,
        target=92.0,
        config=PATH,
        volatility_pct=1.2,
    )
    assert inflated is not None and honest is not None
    assert inflated.rr > 10.0
    assert honest.rr < inflated.rr / 2


def test_the_volatility_floor_is_symmetric() -> None:
    bearish = invalidation_price("bearish", 100.0, 1.0, PATH, volatility_pct=0.8)
    bullish = invalidation_price("bullish", 100.0, 1.0, PATH, volatility_pct=0.8)
    assert bearish - 100.0 == pytest.approx(100.0 - bullish)


def test_a_missing_volatility_read_falls_back_to_the_standing_floor() -> None:
    """No read is not a licence for a zero-width stop.

    With no volatility to clear, the binding floor is whichever of the two
    standing ones is wider — for the default config that is the cost floor,
    since a 0.35% stop would hand 40% of its risk to the round trip.
    """
    stop = invalidation_price("bearish", 100.0, leg_size=0.01, config=PATH, volatility_pct=None)
    assert stop == pytest.approx(100.0 * (1 + risk_floor_pct(PATH) / 100.0))
    assert risk_floor_pct(PATH) == pytest.approx(PATH.cost_floor_pct)
    assert risk_floor_pct(PATH) > PATH.min_risk_pct


def test_intraday_demands_a_wider_stop_than_scalp() -> None:
    from smc.scan_profiles import INTRADAY, SCALP

    assert INTRADAY.path.min_risk_volatility_mult > SCALP.path.min_risk_volatility_mult
    assert INTRADAY.path.min_risk_pct > SCALP.path.min_risk_pct


# ─────────────────────────────────────────────────────────────────────────────
# Generation 5: the floor is a claim about risk, and cost is one of its reasons
# ─────────────────────────────────────────────────────────────────────────────


def test_risk_floor_is_measured_from_entry_not_the_pullback_extreme() -> None:
    """The generation-4 leak: entry sitting inside the buffer collapsed risk.

    Entry sits *past* the pullback extreme — price already traded through the
    retracement low before the setup was taken. The buffer beyond the extreme
    is then partly behind the entry, so bounding the buffer bounds only one leg
    of the risk and the rest is free to collapse. Bounding risk cannot.
    """
    path = build_path(
        "bullish",
        entry=100.0,
        pullback_extreme=100.3,
        leg_size=1.0,
        target=110.0,
        config=PATH,
        volatility_pct=None,
    )
    assert path is not None
    # Buffer alone would have left ~0.26% of risk against a 0.56% floor.
    assert path.risk_pct >= risk_floor_pct(PATH) - 1e-9


def test_a_stop_under_the_floor_is_widened_not_rejected() -> None:
    """Widening is the conservative repair: it can only lower `rr`."""
    path = build_path(
        "bullish",
        entry=100.0,
        pullback_extreme=100.3,
        leg_size=1.0,
        target=110.0,
        config=PATH,
        volatility_pct=None,
    )
    assert path is not None
    assert path.invalidation == pytest.approx(100.0 * (1 - risk_floor_pct(PATH) / 100.0))
    # …and the ratio fell to what the honest stop supports, rather than the
    # ~38R the collapsed one would have advertised.
    assert path.rr == pytest.approx(10.0 / (100.0 * risk_floor_pct(PATH) / 100.0), rel=1e-3)
    assert path.rr < 20.0


def test_the_cost_floor_keeps_fees_inside_their_budget() -> None:
    """Cost as a fraction of R is `round_trip / risk_pct`; the floor caps it."""
    path = build_path(
        "bearish",
        entry=100.0,
        pullback_extreme=100.001,
        leg_size=0.001,
        target=90.0,
        config=PATH,
        volatility_pct=None,
    )
    assert path is not None
    cost_r = PATH.round_trip_cost_pct / path.risk_pct
    assert cost_r <= PATH.max_cost_r + 1e-9


def test_a_volatility_read_can_still_outrank_the_cost_floor() -> None:
    """Cost is a floor, not a ceiling — noise still wins when it is wider."""
    loud = risk_floor_pct(PATH, volatility_pct=4.0)
    assert loud > PATH.cost_floor_pct
    assert loud == pytest.approx(4.0 * PATH.min_risk_volatility_mult)


def test_cost_budget_is_validated() -> None:
    with pytest.raises(ValueError):
        PathConfig(max_cost_r=0.0)
    with pytest.raises(ValueError):
        PathConfig(round_trip_cost_pct=-0.1)
