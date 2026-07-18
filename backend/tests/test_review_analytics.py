"""Unit tests for the pure review analytics functions: RR, best/worst, best
win-rate hour range, session split, and style suitability.

No DB — a small local dataclass satisfies `ClosedTradeLike` structurally.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.review.analytics import (
    compute_hour_range,
    compute_rr,
    compute_sessions,
    compute_style_suitability,
    select_best_worst,
)
from app.review.constants import MIN_STYLE_SAMPLE

BASE_DAY = datetime(2026, 1, 1, 0, 0, 0)


@dataclass
class FakeTrade:
    id: str
    symbol: str = "BTCUSDT"
    side: str = "LONG"
    realized_pnl: float = 0.0
    entry_price: float = 100.0
    exit_price: float = 100.0
    quantity: float = 1.0
    stop_loss: float | None = None
    opened_at: datetime = field(default_factory=lambda: BASE_DAY)
    open_time_source: str = "order_history"
    closed_at: datetime = field(default_factory=lambda: BASE_DAY + timedelta(minutes=10))


# ---------------------------------------------------------------------------
# RR mode selection
# ---------------------------------------------------------------------------


def test_rr_r_multiple_mode_when_enough_stop_evidence() -> None:
    # 5/5 trades have a recorded stop (coverage=1.0 >= 0.3), so R-multiple mode.
    trades = [
        FakeTrade(id="t1", realized_pnl=20.0, entry_price=100.0, stop_loss=90.0, quantity=1.0),
        FakeTrade(id="t2", realized_pnl=-10.0, entry_price=100.0, stop_loss=90.0, quantity=1.0),
        FakeTrade(id="t3", realized_pnl=15.0, entry_price=100.0, stop_loss=90.0, quantity=1.0),
        FakeTrade(id="t4", realized_pnl=5.0, entry_price=100.0, stop_loss=90.0, quantity=1.0),
        FakeTrade(id="t5", realized_pnl=-5.0, entry_price=100.0, stop_loss=90.0, quantity=1.0),
    ]
    rr = compute_rr(trades)
    assert rr.mode == "r_multiple"
    assert rr.label == "R-multiple (stop-based)"
    assert rr.coverage == 1.0
    assert rr.sample_size == 5
    # r-multiples: 2, -1, 1.5, 0.5, -0.5 -> avg 0.5
    assert rr.avg_r_multiple is not None
    assert abs(rr.avg_r_multiple - 0.5) < 1e-9


def test_rr_payoff_ratio_mode_when_insufficient_stop_evidence() -> None:
    # Only 1/5 trades has a stop recorded -> coverage 0.2 < 0.3 threshold.
    trades = [
        FakeTrade(id="t1", realized_pnl=30.0, stop_loss=90.0),
        FakeTrade(id="t2", realized_pnl=10.0),
        FakeTrade(id="t3", realized_pnl=-20.0),
        FakeTrade(id="t4", realized_pnl=-10.0),
        FakeTrade(id="t5", realized_pnl=-10.0),
    ]
    rr = compute_rr(trades)
    assert rr.mode == "payoff_ratio"
    assert rr.label == "% payoff (no stop on record)"
    assert abs(rr.coverage - 0.2) < 1e-9
    # avg_win = (30+10)/2 = 20; avg_loss = (20+10+10)/3 = 13.333...
    assert rr.payoff_ratio is not None
    assert abs(rr.payoff_ratio - (20.0 / (40.0 / 3))) < 1e-6
    assert rr.expectancy_pct is not None


def test_rr_payoff_ratio_mode_when_few_evidenced_trades_even_with_full_coverage() -> None:
    # Coverage 100% but fewer than MIN_STOP_EVIDENCE_TRADES (5) -> still payoff mode.
    trades = [
        FakeTrade(id="t1", realized_pnl=10.0, stop_loss=90.0),
        FakeTrade(id="t2", realized_pnl=-5.0, stop_loss=90.0),
    ]
    rr = compute_rr(trades)
    assert rr.mode == "payoff_ratio"


def test_rr_empty_trades_is_safe() -> None:
    rr = compute_rr([])
    assert rr.mode == "payoff_ratio"
    assert rr.coverage == 0.0
    assert rr.payoff_ratio is None
    assert rr.expectancy_pct is None


# ---------------------------------------------------------------------------
# best / worst tie-break
# ---------------------------------------------------------------------------


def test_best_worst_no_tie() -> None:
    trades = [
        FakeTrade(id="b1", realized_pnl=100.0),
        FakeTrade(id="mid", realized_pnl=0.0),
        FakeTrade(id="w1", realized_pnl=-50.0),
    ]
    best, worst = select_best_worst(trades)
    assert best is not None and best.id == "b1"
    assert worst is not None and worst.id == "w1"


def test_best_worst_tie_break_by_lowest_id() -> None:
    trades = [
        FakeTrade(id="b2", realized_pnl=100.0),
        FakeTrade(id="b1", realized_pnl=100.0),  # tied for best, lower id
        FakeTrade(id="w2", realized_pnl=-50.0),
        FakeTrade(id="w1", realized_pnl=-50.0),  # tied for worst, lower id
    ]
    best, worst = select_best_worst(trades)
    assert best is not None and best.id == "b1"
    assert worst is not None and worst.id == "w1"


def test_best_worst_empty() -> None:
    assert select_best_worst([]) == (None, None)


# ---------------------------------------------------------------------------
# Hour-of-day win-rate range: midnight wrap + MIN_HOUR_SAMPLE exclusion
# ---------------------------------------------------------------------------


def _win_trade(trade_id: str, hour: int, day_offset: int = 0) -> FakeTrade:
    opened = BASE_DAY + timedelta(days=day_offset, hours=hour)
    return FakeTrade(id=trade_id, realized_pnl=10.0, opened_at=opened, closed_at=opened)


def test_hour_range_expands_across_midnight_and_excludes_low_sample_hour() -> None:
    trades = []
    # Hours 23, 0, 1: 3 winning trades each (eligible, 100% winrate).
    for i in range(3):
        trades.append(_win_trade(f"h23_{i}", hour=23, day_offset=0))
        trades.append(_win_trade(f"h0_{i}", hour=0, day_offset=1))
        trades.append(_win_trade(f"h1_{i}", hour=1, day_offset=1))
    # Hour 2: only 2 trades -> below MIN_HOUR_SAMPLE(3), must not be included.
    for i in range(2):
        trades.append(_win_trade(f"h2_{i}", hour=2, day_offset=1))

    result = compute_hour_range(trades)
    assert result is not None
    assert result.start_hour_utc == 23
    assert result.end_hour_utc == 2
    assert result.sample_size == 9
    assert result.win_rate == 100.0


def test_hour_range_none_when_no_hour_meets_min_sample() -> None:
    trades = [_win_trade("a", hour=5), _win_trade("b", hour=5)]  # n=2 < MIN_HOUR_SAMPLE
    assert compute_hour_range(trades) is None


def test_hour_range_empty_trades() -> None:
    assert compute_hour_range([]) is None


def _loss_trade(trade_id: str, hour: int, day_offset: int = 0) -> FakeTrade:
    opened = BASE_DAY + timedelta(days=day_offset, hours=hour)
    return FakeTrade(id=trade_id, realized_pnl=-10.0, opened_at=opened, closed_at=opened)


def test_worst_hour_range_picks_lowest_winrate_hour() -> None:
    trades = []
    # Hours 10, 11: winning (100% winrate, eligible).
    for i in range(3):
        trades.append(_win_trade(f"h10_{i}", hour=10))
        trades.append(_win_trade(f"h11_{i}", hour=11))
    # Hour 15: all losses (0% winrate) -> the trough.
    for i in range(3):
        trades.append(_loss_trade(f"h15_{i}", hour=15))

    best = compute_hour_range(trades)
    worst = compute_hour_range(trades, worst=True)
    assert best is not None and worst is not None
    assert best.win_rate == 100.0
    assert worst.start_hour_utc == 15
    assert worst.end_hour_utc == 16
    assert worst.win_rate == 0.0
    assert worst.sample_size == 3


# ---------------------------------------------------------------------------
# Session split boundary: 7:59 vs 8:00
# ---------------------------------------------------------------------------


def test_session_boundary_759_is_asia_800_is_london() -> None:
    asia_edge = FakeTrade(
        id="a1", realized_pnl=10.0, opened_at=BASE_DAY.replace(hour=7, minute=59)
    )
    london_edge = FakeTrade(
        id="l1", realized_pnl=10.0, opened_at=BASE_DAY.replace(hour=8, minute=0)
    )
    sessions = compute_sessions([asia_edge, london_edge])
    assert sessions.asia.n == 1
    assert sessions.london.n == 1
    assert sessions.new_york.n == 0


def test_session_boundary_1559_london_1600_new_york() -> None:
    london_edge = FakeTrade(
        id="l1", realized_pnl=10.0, opened_at=BASE_DAY.replace(hour=15, minute=59)
    )
    ny_edge = FakeTrade(
        id="n1", realized_pnl=10.0, opened_at=BASE_DAY.replace(hour=16, minute=0)
    )
    sessions = compute_sessions([london_edge, ny_edge])
    assert sessions.london.n == 1
    assert sessions.new_york.n == 1


# ---------------------------------------------------------------------------
# Style suitability: duration boundaries + MIN_STYLE_SAMPLE guard + data_quality
# ---------------------------------------------------------------------------


def _trade_with_duration(
    trade_id: str, duration: timedelta, source: str = "order_history"
) -> FakeTrade:
    opened = BASE_DAY
    return FakeTrade(
        id=trade_id,
        realized_pnl=5.0,
        opened_at=opened,
        closed_at=opened + duration,
        open_time_source=source,
    )


def test_style_duration_boundaries() -> None:
    trades = [
        _trade_with_duration("scalp_edge", timedelta(minutes=29, seconds=59)),
        _trade_with_duration("intraday_lower_edge", timedelta(minutes=30)),
        _trade_with_duration("intraday_upper_edge", timedelta(hours=24)),
        _trade_with_duration("swing_edge", timedelta(hours=24, seconds=1)),
    ]
    style = compute_style_suitability(trades)
    assert style.buckets.scalp.n == 1
    assert style.buckets.intraday.n == 2
    assert style.buckets.swing.n == 1


def test_style_min_sample_guard_no_recommendation() -> None:
    # Only 2 trades per bucket -> below MIN_STYLE_SAMPLE(5); no recommendation.
    trades = [
        _trade_with_duration("s1", timedelta(minutes=5)),
        _trade_with_duration("s2", timedelta(minutes=5)),
    ]
    style = compute_style_suitability(trades)
    assert style.recommended is None
    assert style.confidence == "low"


def test_style_recommendation_when_bucket_meets_min_sample() -> None:
    trades = [
        _trade_with_duration(f"scalp_{i}", timedelta(minutes=5)) for i in range(MIN_STYLE_SAMPLE)
    ]
    style = compute_style_suitability(trades)
    assert style.recommended == "scalp"
    assert style.confidence == "high"


def test_style_data_quality_flips_to_estimated_fallback_below_10_order_history() -> None:
    # Fewer than 10 order_history trades -> falls back to using ALL trades,
    # data_quality flips to "estimated_fallback".
    trades = [
        _trade_with_duration(f"oh_{i}", timedelta(minutes=5), source="order_history")
        for i in range(3)
    ]
    trades += [
        _trade_with_duration(f"est_{i}", timedelta(minutes=5), source="estimated")
        for i in range(3)
    ]
    style = compute_style_suitability(trades)
    assert style.data_quality == "estimated_fallback"
    assert style.buckets.scalp.n == 6  # falls back to ALL trades, not just order_history


def test_style_data_quality_stays_order_history_at_or_above_10() -> None:
    trades = [
        _trade_with_duration(f"oh_{i}", timedelta(minutes=5), source="order_history")
        for i in range(10)
    ]
    trades += [
        _trade_with_duration(f"est_{i}", timedelta(minutes=5), source="estimated")
        for i in range(3)
    ]
    style = compute_style_suitability(trades)
    assert style.data_quality == "order_history"
    assert style.buckets.scalp.n == 10  # only the order_history trades counted
