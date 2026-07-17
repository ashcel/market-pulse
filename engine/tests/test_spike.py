"""Port of spike.test.ts."""

import re

from smc.spike import (
    REF_WINDOW,
    REJECT_FRACTION,
    SPIKE_RANGE_MULT,
    SPIKE_VOLUME_MULT,
    detect_spike,
)
from smc.types import Candle


def candle(time: int, open_: float, high: float, low: float, close: float, volume: float) -> Candle:
    return Candle(time=time, open=open_, high=high, low=low, close=close, volume=volume)


def calm_run(
    count: int,
    price: float = 100,
    range_: float = 1,
    volume: float = 1_000,
    start_time: int = 0,
) -> list[Candle]:
    """A calm trailing reference: `count` flat unit-range bars at `price`, low volume."""
    return [
        candle(start_time + i, price, price + range_ / 2, price - range_ / 2, price, volume)
        for i in range(count)
    ]


def up_spike_reject(time: int, base: float = 100) -> Candle:
    # range 10 (~10x the calm 1.0 range), closes at base so the whole 10 is upper wick.
    return candle(time, base, base + 10, base, base, 8_000)


def test_flags_a_vertical_up_spike_on_abnormal_volume_that_closes_rejected() -> None:
    candles = [*calm_run(REF_WINDOW), up_spike_reject(REF_WINDOW)]
    event = detect_spike(candles)
    assert event is not None
    assert event.direction == "up"
    assert event.bars_ago == 0
    assert event.time == REF_WINDOW
    assert event.range_mult >= SPIKE_RANGE_MULT
    assert event.volume_mult >= SPIKE_VOLUME_MULT
    assert event.rejection_fraction >= REJECT_FRACTION
    assert re.search(r"up-spike rejected", event.reason)


def test_mirrors_for_a_down_spike_and_reject_dominant_lower_wick() -> None:
    # range 10, closes back at base → whole 10 is the lower wick.
    down = candle(REF_WINDOW, 100, 100, 90, 100, 8_000)
    event = detect_spike([*calm_run(REF_WINDOW), down])
    assert event is not None
    assert event.direction == "down"
    assert re.search(r"down-spike rejected", event.reason)


def test_does_not_flag_a_breakout_no_rejection_wick() -> None:
    # A vertical bar that closes at its extreme is a breakout, not a rejection.
    breakout = candle(REF_WINDOW, 100, 110, 100, 110, 8_000)
    assert detect_spike([*calm_run(REF_WINDOW), breakout]) is None


def test_does_not_flag_a_long_wick_rejection_on_ordinary_volume() -> None:
    # Same rejection shape, but volume is in line with the calm reference.
    quiet_wick = candle(REF_WINDOW, 100, 110, 100, 100, 1_100)
    assert detect_spike([*calm_run(REF_WINDOW), quiet_wick]) is None


def test_does_not_flag_a_high_volume_bar_that_is_not_vertical() -> None:
    heavy_but_flat = candle(REF_WINDOW, 100, 100.5, 99.5, 100, 8_000)
    assert detect_spike([*calm_run(REF_WINDOW), heavy_but_flat]) is None


def test_ignores_a_qualifying_spike_older_than_the_recency_window() -> None:
    # Spike, then two more calm bars push it out of the last-2-bars window.
    candles = [
        *calm_run(REF_WINDOW),
        up_spike_reject(REF_WINDOW),
        *calm_run(2, 100, 1, 1_000, REF_WINDOW + 1),
    ]
    assert detect_spike(candles) is None


def test_returns_the_most_recent_spike_when_two_are_in_window() -> None:
    candles = [
        *calm_run(REF_WINDOW),
        up_spike_reject(REF_WINDOW),
        candle(REF_WINDOW + 1, 100, 100, 90, 100, 8_000),  # down-spike, newer
    ]
    event = detect_spike(candles)
    assert event is not None
    assert event.direction == "down"
    assert event.bars_ago == 0


def test_returns_none_without_enough_bars_for_a_trailing_reference() -> None:
    assert detect_spike([*calm_run(5), up_spike_reject(5)]) is None


def test_returns_none_on_a_calm_series_with_no_spike() -> None:
    assert detect_spike(calm_run(REF_WINDOW + 5)) is None
