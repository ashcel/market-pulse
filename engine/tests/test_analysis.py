"""Port of analysis.test.ts.

The evaluate_signal regression tests from the TS file land with quant.py's
port — they exercise quant, not analysis.
"""

from smc.analysis import (
    MAX_DISPLAY_PIVOTS,
    compute_pivots,
    compute_trend_lines,
    select_display_pivots,
)
from smc.mock_candles import generate_mock_candles
from smc.types import Candle


def make_series(symbol: str = "BTC", bars: int = 200) -> list[Candle]:
    return generate_mock_candles(symbol, "1H", bars)


class TestComputePivots:
    def test_returns_more_than_max_display_pivots_for_meaningful_structure(self) -> None:
        # The adaptive window k = ceil(n/40) shrinks relative to bar count, so
        # more local extrema survive the confirmation window.
        pivots = compute_pivots(make_series("DOGE", 500))
        assert len(pivots) > MAX_DISPLAY_PIVOTS

    def test_returns_pivots_sorted_by_time_ascending(self) -> None:
        pivots = compute_pivots(make_series())
        for i in range(1, len(pivots)):
            assert pivots[i].time >= pivots[i - 1].time

    def test_returns_empty_when_candles_too_short_for_the_window(self) -> None:
        assert compute_pivots(make_series("ETH", 3)) == []

    def test_returns_empty_for_empty_input(self) -> None:
        assert compute_pivots([]) == []

    def test_every_pivot_has_a_valid_kind(self) -> None:
        for p in compute_pivots(make_series()):
            assert p.kind in ("high", "low")


class TestSelectDisplayPivots:
    def test_caps_output_to_max_display_pivots_by_default(self) -> None:
        candles = make_series()
        display = select_display_pivots(compute_pivots(candles), candles)
        assert len(display) <= MAX_DISPLAY_PIVOTS

    def test_respects_a_custom_max_count(self) -> None:
        candles = make_series()
        display = select_display_pivots(compute_pivots(candles), candles, 4)
        assert len(display) <= 4

    def test_preserves_time_ordering(self) -> None:
        candles = make_series()
        display = select_display_pivots(compute_pivots(candles), candles)
        for i in range(1, len(display)):
            assert display[i].time >= display[i - 1].time

    def test_returns_a_subset_of_the_full_pivot_set(self) -> None:
        candles = make_series()
        all_pivots = compute_pivots(candles)
        display = select_display_pivots(all_pivots, candles)
        full_set = {(p.time, p.kind, p.price) for p in all_pivots}
        for p in display:
            assert (p.time, p.kind, p.price) in full_set

    def test_returns_all_pivots_unchanged_when_at_or_below_max_count(self) -> None:
        candles = make_series("ETH", 30)
        all_pivots = compute_pivots(candles)
        if len(all_pivots) <= MAX_DISPLAY_PIVOTS:
            assert select_display_pivots(all_pivots, candles) == all_pivots

    def test_selects_a_non_empty_display_set_when_pivots_exist(self) -> None:
        candles = make_series("BTC", 200)
        all_pivots = compute_pivots(candles)
        display = select_display_pivots(all_pivots, candles)
        if all_pivots:
            assert len(display) > 0


class TestDownstreamConsumers:
    def test_compute_trend_lines_produces_valid_output_with_full_pivot_set(self) -> None:
        candles = make_series("SOL", 200)
        lines = compute_trend_lines(candles, compute_pivots(candles))
        assert isinstance(lines.support, list)
        assert isinstance(lines.resistance, list)
