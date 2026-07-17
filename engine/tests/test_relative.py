"""Port of relative.test.ts."""

import math

import pytest

from smc.relative import compute_relative_read, pearson
from smc.types import Candle


def series(closes: list[float], start_time: int = 0, step: int = 3600) -> list[Candle]:
    return [
        Candle(time=start_time + i * step, open=close, high=close, low=close, close=close, volume=1)
        for i, close in enumerate(closes)
    ]


def test_pearson_is_1_for_a_linear_relation_and_minus_1_for_its_inverse() -> None:
    assert pearson([1, 2, 3, 4], [2, 4, 6, 8]) == pytest.approx(1, abs=1e-10)
    assert pearson([1, 2, 3, 4], [8, 6, 4, 2]) == pytest.approx(-1, abs=1e-10)


def test_pearson_matches_a_hand_computed_value() -> None:
    # r for x=[1,2,3], y=[1,3,2] is 0.5
    assert pearson([1, 2, 3], [1, 3, 2]) == pytest.approx(0.5, abs=1e-10)


def test_pearson_is_none_on_zero_variance_or_too_short_input() -> None:
    assert pearson([1, 1, 1], [1, 2, 3]) is None
    assert pearson([1], [2]) is None


def test_computes_rs_as_the_difference_of_the_two_series_own_percent_changes() -> None:
    n = 200
    # Asset +50% over the window vs BTC flat: both linear ramps.
    asset = series([100 + i * 0.5 for i in range(n)])
    btc = series([100.0 for _ in range(n)])
    read = compute_relative_read(asset, btc)
    assert read.rs_btc24h > 0
    assert read.rs_btc7d > read.rs_btc24h  # longer ramp, bigger gap


def test_reads_corr_1_for_identical_return_streams_and_pairs_strictly_by_bar_time() -> None:
    n = 200
    closes = [100 * (1 + 0.001 * math.sin(i)) for i in range(n)]
    asset = series(closes)
    btc = series(closes)
    assert compute_relative_read(asset, btc).corr_btc7d == pytest.approx(1, abs=1e-6)

    # Time-shift BTC by one bar: naive index pairing would still see identical
    # arrays; time-aligned pairing must compare shifted returns instead.
    shifted = series(closes, 3600)
    corr_shifted = compute_relative_read(asset, shifted).corr_btc7d
    assert corr_shifted is not None
    assert corr_shifted < 0.99


def test_returns_none_corr_below_the_48_overlapping_returns_floor_but_still_reads_rs() -> None:
    asset = series([100 + i for i in range(30)])
    btc = series([100.0 for _ in range(30)])
    read = compute_relative_read(asset, btc)
    assert read.corr_btc7d is None
    assert read.rs_btc24h > 0
