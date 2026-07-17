"""New pins for tracker.py (the TS module had no dedicated suite): the shared
first-touch-wins walk — stop before target2 before target1 within a bar —
and candle-based catch-up settlement."""

from smc.hysteresis import iso_from_ms
from smc.tracker import (
    ExitLevels,
    TrackedSignal,
    evaluate_tracked_signal,
    settle_tracked_signal_with_candles,
    summarize_tracked_signals,
    walk_exit_levels,
)
from smc.types import Candle

HOUR = 3600


def bar(time: int, low: float, high: float, close: float | None = None) -> Candle:
    mid = (low + high) / 2
    return Candle(
        time=time, open=mid, high=high, low=low, close=close if close is not None else mid,
        volume=1,
    )


LONG = ExitLevels(direction="long", entry=100, stop=95, target1=110, target2=120)


class TestWalkExitLevels:
    def test_stop_checked_first_within_a_bar(self) -> None:
        # One bar sweeps both the stop and target2: conservative stop wins.
        exit_ = walk_exit_levels(LONG, [bar(HOUR, 94, 121)])
        assert exit_ is not None
        assert exit_.status == "stopped-out"
        assert exit_.exit_level == 95
        assert exit_.result_r == -1

    def test_target2_beats_target1_within_a_bar(self) -> None:
        exit_ = walk_exit_levels(LONG, [bar(HOUR, 105, 121)])
        assert exit_ is not None
        assert exit_.status == "target2-hit"
        assert exit_.result_r == 4

    def test_target1_when_only_it_prints(self) -> None:
        exit_ = walk_exit_levels(LONG, [bar(HOUR, 105, 111)])
        assert exit_ is not None
        assert exit_.status == "target1-hit"
        assert exit_.result_r == 2

    def test_none_when_no_level_touched(self) -> None:
        assert walk_exit_levels(LONG, [bar(HOUR, 101, 106)]) is None

    def test_mirrors_for_shorts(self) -> None:
        short = ExitLevels(direction="short", entry=100, stop=105, target1=90, target2=80)
        exit_ = walk_exit_levels(short, [bar(HOUR, 79, 99)])
        assert exit_ is not None
        assert exit_.status == "target2-hit"
        assert exit_.result_r == 4


def tracked(**overrides: object) -> TrackedSignal:
    fields: dict[str, object] = {
        "id": "t-1",
        "symbol": "BTC",
        "intent": "intraday",
        "direction": "long",
        "setup_type": "breakout",
        "timeframe": "1H",
        "entry_low": 99,
        "entry_high": 101,
        "entry_price": 100,
        "stop": 95,
        "target1": 110,
        "target2": 120,
        "confidence_at_follow": 70,
        "followed_at": iso_from_ms(0),
        "status": "active",
    }
    fields.update(overrides)
    return TrackedSignal(**fields)  # type: ignore[arg-type]


class TestEvaluateTrackedSignal:
    def test_polled_price_hits_stop(self) -> None:
        patch = evaluate_tracked_signal(tracked(), 94.5, "now")
        assert patch is not None
        assert patch.status == "stopped-out"
        # R is measured to the stop level, not the polled print.
        assert patch.result_r == -1

    def test_terminal_records_never_repatch(self) -> None:
        assert evaluate_tracked_signal(tracked(status="target1-hit"), 94.5, "now") is None

    def test_garbage_price_is_ignored(self) -> None:
        assert evaluate_tracked_signal(tracked(), float("nan"), "now") is None
        assert evaluate_tracked_signal(tracked(), 0, "now") is None


class TestSettleWithCandles:
    def test_only_bars_after_follow_time_count(self) -> None:
        # The bar in progress at follow time partially predates the entry.
        assert settle_tracked_signal_with_candles(tracked(), [bar(0, 90, 108)]) is None

    def test_catches_wick_through_stop(self) -> None:
        patch = settle_tracked_signal_with_candles(tracked(), [bar(HOUR, 94, 106)])
        assert patch is not None
        assert patch.status == "stopped-out"
        assert patch.close_price == 95
        assert patch.closed_at == iso_from_ms((HOUR + HOUR) * 1000)


class TestSummarize:
    def test_aggregates_and_flags_low_sample(self) -> None:
        signals = [
            tracked(status="target1-hit", result_r=2),
            tracked(status="stopped-out", result_r=-1),
            tracked(),
        ]
        summary = summarize_tracked_signals(signals)
        assert summary.total == 3
        assert summary.open == 1
        assert summary.closed == 2
        assert summary.wins == 1
        assert summary.losses == 1
        assert summary.win_rate == 50
        assert summary.average_r == 0.5
        assert summary.low_sample is True
