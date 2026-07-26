"""Pure forensics fixtures — the worked examples in docs/forensics-definitions.md §6."""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest

from app.review.forensics import (
    INTERVAL_MS,
    LOCAL_TZ,
    MetricValue,
    UnavailableReason,
    boundary_inflation_bound_pct,
    choose_interval,
    compute_mae,
    compute_mfe,
    compute_window,
    detect_partial_close_groups,
    disclose_boundary_inflation,
    excursion_unavailable_reason,
    exit_efficiency,
    normalize_timestamp,
    reentry_latency,
    sizing_variance,
    stop_discipline,
    stop_evidence_of,
)
from app.review.forensics_service import build_forensics


@dataclass
class FakeTrade:
    id: str = "t1"
    user_id: str = "u1"
    symbol: str = "BTCUSDT"
    side: str = "LONG"
    entry_price: float = 100.0
    exit_price: float = 106.0
    quantity: float = 1.0
    realized_pnl: float = 6.0
    stop_loss: float | None = None
    close_trigger: str | None = "manual_market"
    opened_at: datetime = field(default_factory=lambda: datetime(2026, 7, 26, 12, 0))
    closed_at: datetime = field(default_factory=lambda: datetime(2026, 7, 26, 12, 5))
    open_time_source: str = "user_trades"


def candles(count: int, high: float, low: float, start_ms: int, step_ms: int = 60_000):
    return [
        {"open_time": start_ms + index * step_ms, "high": high, "low": low,
         "open": low, "close": high}
        for index in range(count)
    ]


def _payload(trade: FakeTrade, rows, now_offset_ms: int = 10 * 60_000, **overrides):
    kwargs = {
        "testnet": False,
        "partial_close_ids": frozenset(),
        "cohort": sizing_variance([trade]),
        "now_ms": normalize_timestamp(trade.closed_at) + now_offset_ms,
    }
    return build_forensics(trade, [trade], rows, **{**kwargs, **overrides})


# --- §6 worked examples -------------------------------------------------------


def test_example_a_long_btc():
    mae = compute_mae("LONG", 50_000, 1, 47_500, 56_000, 48_000)
    mfe = compute_mfe("LONG", 50_000, 1, 47_500, 56_000, 48_000)
    assert mae["percent"].value == pytest.approx(5)
    assert mfe["percent"].value == pytest.approx(12)
    assert exit_efficiency("LONG", 50_000, 55_000, 47_500, 56_000).value == pytest.approx(83.333333)


def test_example_b_short_eth_sign_flip():
    mae = compute_mae("SHORT", 3_000, 1, 2_700, 3_100, 3_100)
    mfe = compute_mfe("SHORT", 3_000, 1, 2_700, 3_100, 3_100)
    assert mae["percent"].value == pytest.approx(100 / 3_000 * 100)
    assert mfe["percent"].value == pytest.approx(10)
    assert mae["percent"].value != mfe["percent"].value


def test_example_c_no_stop_keeps_excursions_but_suppresses_r():
    mae = compute_mae("LONG", 10, 100, 10, 10.5)
    mfe = compute_mfe("LONG", 10, 100, 10, 10.5)
    assert mae["percent"].available and mae["percent"].value == 0
    assert mfe["percent"].available and mfe["percent"].value == pytest.approx(5)
    for metric in (mae["r"], mfe["r"]):
        assert not metric.available
        assert metric.value is None
        assert metric.reason == UnavailableReason.NO_STOP_ON_RECORD


def test_example_d_negligible_mfe_and_stop_discipline():
    efficiency = exit_efficiency("LONG", 200, 193.5, 193.2, 200.1)
    assert not efficiency.available
    assert efficiency.reason == UnavailableReason.NEGLIGIBLE_FAVORABLE_EXCURSION
    discipline = stop_discipline("LONG", 200, 193.5, 195, "sl_hit", 193.2, 200.1)
    assert discipline["slippage_adverse_r"].value == pytest.approx(0.3)
    assert discipline["violation_depth_r"].value == pytest.approx(0.36)
    assert discipline["realized_r"].value == pytest.approx(-1.3)
    assert discipline["stop_evidence"] == "hit"
    assert discipline["discipline_breach"] is False


def test_example_f_sizing_variance_notional_mode():
    trades = [
        FakeTrade(id=f"t{index}", quantity=quantity)
        for index, quantity in enumerate([1.0, 1.0, 2.0, 3.0, 8.0])
    ]
    cohort = sizing_variance(trades)
    assert cohort["mode"] == "notional_based"
    assert cohort["n"] == 5
    assert cohort["median"].value == pytest.approx(200.0)
    # Tukey hinges exclude the overall median when N is odd.
    assert cohort["q1"].value == pytest.approx(100.0)
    assert cohort["q3"].value == pytest.approx(550.0)
    assert cohort["cv_percent"].available


def test_timestamp_local_wall_time_round_trip():
    naive = datetime(2026, 7, 26, 12, 34, 56, 789000)
    epoch_ms = normalize_timestamp(naive)
    restored = datetime.fromtimestamp(epoch_ms / 1000, LOCAL_TZ).replace(tzinfo=None)
    assert restored == naive


def test_interval_ladder_and_boundary_aligned_window():
    assert choose_interval(15 * 60 * 60) == "1m"
    assert choose_interval(15 * 60 * 60 + 1) == "5m"
    assert choose_interval(901 * 24 * 60 * 60) == "1d"
    assert compute_window(0, 300_000, 60_000) == {
        "first_open_ms": 0, "last_open_ms": 240_000, "candle_count": 5,
    }


# --- R1 / R3: R needs an evidenced stop, and nothing is a silent null ---------


def test_non_stopped_trade_never_returns_r_value():
    results = [
        compute_mae("LONG", 100, 1, 95, 110, None),
        compute_mfe("LONG", 100, 1, 95, 110, None),
        stop_discipline("LONG", 100, 105, None, "manual_market", 95, 110),
    ]
    r_metrics = [
        metric
        for result in results
        for metric in result.values()
        if isinstance(metric, MetricValue) and metric.unit == "r_multiple"
    ]
    assert r_metrics
    assert all(not metric.available and metric.value is None for metric in r_metrics)


def test_persisted_row_never_carries_an_r_value_without_a_stop():
    """The honesty rule has to survive persistence, not just the pure layer."""
    trade = FakeTrade(stop_loss=None)
    payload = _payload(trade, candles(5, 106.0, 98.0, normalize_timestamp(trade.opened_at)))
    assert payload is not None
    r_metrics = [
        metric for metric in payload["metrics"].values() if metric["unit"] == "r_multiple"
    ]
    assert r_metrics
    for metric in r_metrics:
        assert metric["available"] is False
        assert metric["value"] is None
        assert metric["reason"] == UnavailableReason.NO_STOP_ON_RECORD.value


def test_no_persisted_metric_is_ever_a_silent_null():
    trade = FakeTrade(stop_loss=96.0, close_trigger="sl_hit")
    payload = _payload(trade, candles(5, 106.0, 95.0, normalize_timestamp(trade.opened_at)))
    assert payload is not None
    assert payload["metrics"]
    for key, metric in payload["metrics"].items():
        assert (metric["value"] is None) == (not metric["available"]), key
        assert (metric["reason"] is None) == metric["available"], key


def test_blocked_trade_still_reports_every_metric_with_a_reason():
    trade = FakeTrade(open_time_source="estimated")
    payload = _payload(trade, candles(5, 106.0, 98.0, normalize_timestamp(trade.opened_at)))
    assert payload is not None
    assert payload["metrics"]["mae_percent"]["reason"] == "estimated_open_time"
    assert payload["metrics"]["reentry_latency_seconds"]["reason"] == "estimated_open_time"


# --- §3 reason ordering -------------------------------------------------------


def _reason(trade: FakeTrade, **overrides):
    kwargs = {
        "testnet": False, "partial_close_suspected": False, "symbol_resolvable": True,
        "interval_ms": INTERVAL_MS["1m"], "candle_count": 5, "pending_bar_close": False,
    }
    return excursion_unavailable_reason(trade, **{**kwargs, **overrides})


def test_not_enriched_sorts_before_klines_unavailable():
    assert _reason(FakeTrade(entry_price=0.0), candle_count=0) == UnavailableReason.NOT_ENRICHED


def test_reason_order_is_fixed_top_to_bottom():
    assert _reason(FakeTrade(), testnet=True) == UnavailableReason.TESTNET_SOURCE
    assert (
        _reason(FakeTrade(open_time_source="estimated"))
        == UnavailableReason.ESTIMATED_OPEN_TIME
    )
    assert (
        _reason(FakeTrade(), partial_close_suspected=True)
        == UnavailableReason.UNDEFINED_FOR_PARTIAL_CLOSE
    )
    assert _reason(FakeTrade(), symbol_resolvable=False) == UnavailableReason.SYMBOL_UNRESOLVABLE
    assert _reason(FakeTrade(), pending_bar_close=True) == UnavailableReason.PENDING_BAR_CLOSE
    assert _reason(FakeTrade(), candle_count=0) == UnavailableReason.KLINES_UNAVAILABLE
    assert _reason(FakeTrade(), candle_count=2) == UnavailableReason.INSUFFICIENT_CANDLES
    assert _reason(FakeTrade()) is None


def test_sub_three_minute_scalp_is_resolution_too_coarse():
    assert _reason(FakeTrade(closed_at=datetime(2026, 7, 26, 12, 2))) == (
        UnavailableReason.RESOLUTION_TOO_COARSE
    )


def test_pending_bar_close_writes_no_row():
    trade = FakeTrade()
    rows = candles(5, 106.0, 98.0, normalize_timestamp(trade.opened_at))
    # The 12:04 bar only closes at 12:05:00; at 12:04:30 it can still widen.
    assert _payload(trade, rows, now_offset_ms=-30_000) is None
    assert _payload(trade, rows, now_offset_ms=0) is not None


# --- §4.4 boundary inflation --------------------------------------------------


def test_boundary_inflation_bound_is_the_worst_boundary_candle_range():
    first = {"high": 101.0, "low": 99.0}
    last = {"high": 106.0, "low": 102.0}
    assert boundary_inflation_bound_pct(first, last, 100.0) == pytest.approx(4.0)


def test_material_boundary_bound_flags_the_percent_representation():
    metrics = {"mae_percent": MetricValue(True, 1.0, "percent_of_entry")}
    assert "boundary_inflated" in disclose_boundary_inflation(metrics, 4.0)["mae_percent"].flags
    assert "boundary_inflated" not in disclose_boundary_inflation(metrics, 0.1)["mae_percent"].flags


# --- §5.4 stop evidence -------------------------------------------------------


def test_stop_evidence_branches():
    assert stop_evidence_of(96.0, "sl_hit") == "hit"
    assert stop_evidence_of(None, "liquidation") == "liquidated"
    assert stop_evidence_of(None, "manual_market") == "absent"


def test_liquidation_sets_breach_without_inventing_numbers():
    discipline = stop_discipline("LONG", 100, 90, None, "liquidation", 89, 101)
    assert discipline["stop_evidence"] == "liquidated"
    assert discipline["discipline_breach"] is True
    assert discipline["realized_r"].reason == UnavailableReason.NO_STOP_ON_RECORD


def test_violation_depth_is_unavailable_when_klines_are():
    discipline = stop_discipline(
        "LONG", 100, 95, 96.0, "sl_hit",
        depth_unavailable=UnavailableReason.INSUFFICIENT_CANDLES,
    )
    assert discipline["violation_depth_r"].reason == UnavailableReason.INSUFFICIENT_CANDLES
    assert discipline["slippage_adverse_r"].available  # not kline-dependent


# --- §5.5 re-entry prerequisites ---------------------------------------------


def _pair(gap_minutes: int, **overrides) -> tuple[FakeTrade, FakeTrade]:
    first = FakeTrade(
        id="a", opened_at=datetime(2026, 7, 26, 10, 0), closed_at=datetime(2026, 7, 26, 10, 30),
        realized_pnl=-5.0, **overrides,
    )
    second = FakeTrade(
        id="b",
        opened_at=first.closed_at + timedelta(minutes=gap_minutes),
        closed_at=first.closed_at + timedelta(minutes=gap_minutes + 30),
    )
    return first, second


def test_reentry_latency_and_companions():
    first, second = _pair(4)
    result = reentry_latency(second, [first, second])
    assert result["latency"].value == pytest.approx(240)
    assert result["after_loss"] is True
    assert result["same_direction"] is True


def test_estimated_predecessor_makes_the_gap_fiction():
    first, second = _pair(4, open_time_source="estimated")
    assert (
        reentry_latency(second, [first, second])["latency"].reason
        == UnavailableReason.ESTIMATED_OPEN_TIME
    )


def test_partial_close_member_gets_no_latency():
    first, second = _pair(4)
    result = reentry_latency(second, [first, second], frozenset({"b"}))
    assert result["latency"].reason == UnavailableReason.UNDEFINED_FOR_PARTIAL_CLOSE


def test_overlap_sorts_before_no_prior_trade():
    first, second = _pair(-10)
    assert (
        reentry_latency(second, [first, second])["latency"].reason
        == UnavailableReason.OVERLAPPING_POSITIONS
    )
    assert (
        reentry_latency(FakeTrade(id="solo"), [])["latency"].reason
        == UnavailableReason.NO_PRIOR_TRADE_IN_WINDOW
    )


# --- §7.5 partial closes ------------------------------------------------------


def test_scale_out_fragments_are_detected_and_counted():
    opened = datetime(2026, 7, 26, 9, 0)
    fragments = [
        FakeTrade(
            id=f"f{index}", opened_at=opened, closed_at=opened + timedelta(minutes=10 + index)
        )
        for index in range(3)
    ]
    suspected = detect_partial_close_groups(fragments)
    assert suspected == {"f0", "f1", "f2"}
    assert sizing_variance(fragments, frozenset(suspected))["partial_close_rows"] == 3


# --- §5.6 sizing states -------------------------------------------------------


def test_small_cohort_is_insufficient_sample_not_zero():
    cohort = sizing_variance([FakeTrade(id="a"), FakeTrade(id="b")])
    assert cohort["cv_percent"].reason == UnavailableReason.INSUFFICIENT_SAMPLE
    assert cohort["cv_percent"].value is None


def test_identical_sizes_are_a_degenerate_cohort():
    trades = [FakeTrade(id=f"t{index}") for index in range(6)]
    assert sizing_variance(trades)["cv_percent"].reason == UnavailableReason.DEGENERATE_COHORT


# --- §8.3 session grid --------------------------------------------------------


def test_session_grid_uses_the_engine_windows():
    from app.worker.context_stamper import session_of

    assert session_of(datetime(2026, 7, 26, 3, tzinfo=UTC)) == "asia"
    assert session_of(datetime(2026, 7, 26, 9, tzinfo=UTC)) == "eu"
    assert session_of(datetime(2026, 7, 26, 15, tzinfo=UTC)) == "us"
    assert session_of(datetime(2026, 7, 26, 22, tzinfo=UTC)) == "off_hours"
