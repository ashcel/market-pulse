"""The IC report's arithmetic, and the two things it must never do: read a
close from the future, or turn a missing measurement into a zero."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from smc.types import Candle

from app.research.ic_report import (
    BAR_SECONDS,
    HORIZONS,
    MIN_SECTION,
    Detection,
    attach_forward_returns,
    build,
    ex_top_symbols_ic,
    fetch_window,
    forward_returns_at,
    jackknife_symbols,
    pearson,
    per_symbol_ic,
    pooled_ic,
    ranks,
    render,
    sectional_ic,
    sections_for,
    spearman,
)

T0 = datetime(2026, 8, 12, 12, 0, tzinfo=UTC)


def candles(closes: list[float], start: datetime = T0) -> list[Candle]:
    """Ascending 1m bars whose `time` labels the bar's open, as Binance sends
    them and `app.worker.binance._parse_klines` stores them."""
    base = int(start.timestamp())
    return [
        Candle(time=base + i * BAR_SECONDS, open=c, high=c, low=c, close=c, volume=1.0)
        for i, c in enumerate(closes)
    ]


def detection(**overrides: object) -> Detection:
    base: dict[str, object] = dict(
        id="1",
        symbol="TSTUSDT",
        mode="SCALP",
        direction="bullish",
        detected_at=T0,
        score=60.0,
        tier="HIGH",
        combo="structure+activity",
        status="INVALIDATED",
        gross_r=-1.0,
        realized_r=-1.1,
    )
    base.update(overrides)
    return Detection(**base)  # type: ignore[arg-type]


# ── rank statistics ──────────────────────────────────────────────────────────


def test_ties_share_an_averaged_rank() -> None:
    """The score is quantised, so ties are common. Breaking them by list
    position would manufacture correlation out of arrival order."""
    assert ranks([10.0, 20.0, 20.0, 30.0]) == [1.0, 2.5, 2.5, 4.0]


def test_spearman_sees_a_monotone_relation_pearson_would_understate() -> None:
    xs = [1.0, 2.0, 3.0, 4.0, 5.0]
    ys = [1.0, 2.0, 4.0, 8.0, 16.0]
    rho = spearman(xs, ys)
    r = pearson(xs, ys)
    assert rho == pytest.approx(1.0)
    assert r is not None and r < rho


def test_a_constant_side_is_undefined_rather_than_zero() -> None:
    """A funnel that only admits one score is a fact about the funnel. Calling
    that a zero IC would report it as evidence about the score."""
    assert spearman([50.0] * 5, [1.0, 2.0, 3.0, 4.0, 5.0]) is None


def test_too_few_points_yield_no_correlation() -> None:
    assert spearman([1.0, 2.0], [1.0, 2.0]) is None


def test_a_perfect_ranking_is_significant_and_a_scrambled_one_is_not() -> None:
    scores = [float(i) for i in range(40)]
    good = pooled_ic(scores, scores, "5m")
    assert good is not None
    assert good.ic == pytest.approx(1.0)
    assert good.marked

    scrambled = [float(i % 2) for i in range(40)]
    weak = pooled_ic(scores, scrambled, "5m")
    assert weak is not None
    assert abs(weak.ic) < 0.2
    assert not weak.marked


def test_a_pooled_ic_reports_the_score_dispersion_beside_it() -> None:
    """A near-zero IC on a near-constant score is range truncation, not a
    finding, and the reader has to be able to tell."""
    result = pooled_ic([50.0, 50.0, 50.0, 51.0], [1.0, 2.0, 3.0, 4.0], "1m")
    assert result is not None
    assert result.score_span == (50.0, 51.0)
    assert result.unique_scores == 2


# ── no lookahead ─────────────────────────────────────────────────────────────


def test_the_anchor_is_the_last_close_that_had_already_happened() -> None:
    """`Candle.time` labels the bar's *open*, so the bar containing detection
    closes in the future. Anchoring on it would read a price that had not
    happened."""
    series = candles([100.0, 101.0, 102.0, 103.0, 104.0])
    # Detection lands inside the bar opening at T0 + 60s, which closes at
    # T0 + 120s. The newest already-closed bar is the one opening at T0.
    at = T0 + timedelta(seconds=90)
    forward = forward_returns_at(series, at, "bullish")
    # base = 100.0 (bar 0's close), +1m = bar 1's close = 101.0.
    assert forward["1m"] == pytest.approx(1.0)


def test_a_detection_before_any_closed_bar_has_no_forward_return() -> None:
    series = candles([100.0, 101.0, 102.0])
    assert forward_returns_at(series, T0, "bullish") == {}


def test_a_horizon_past_the_end_of_the_series_is_omitted_not_zero() -> None:
    """The future this row would describe has not happened yet. Nothing is
    padded or carried forward."""
    series = candles([100.0] * 10)
    forward = forward_returns_at(series, T0 + timedelta(minutes=8), "bullish")
    assert "1m" in forward
    assert "15m" not in forward
    assert "2h" not in forward


def test_no_candles_yields_no_returns() -> None:
    assert forward_returns_at([], T0, "bullish") == {}


# ── direction ────────────────────────────────────────────────────────────────


def test_a_bearish_setup_is_right_when_price_falls() -> None:
    falling = candles([100.0, 99.0, 98.0, 97.0, 96.0, 95.0, 94.0])
    at = T0 + timedelta(seconds=90)
    bear = forward_returns_at(falling, at, "bearish")
    bull = forward_returns_at(falling, at, "bullish")
    assert bear["1m"] > 0
    assert bull["1m"] == pytest.approx(-bear["1m"])


# ── cross-sections ───────────────────────────────────────────────────────────


def test_a_thin_bucket_is_dropped_rather_than_ranked() -> None:
    rows = [
        detection(id=str(i), score=float(50 + i), detected_at=T0 + timedelta(minutes=i))
        for i in range(MIN_SECTION - 1)
    ]
    for i, row in enumerate(rows):
        row.forward = {"5m": float(i)}
    assert sections_for(rows, "5m") == []


def test_a_full_bucket_is_kept() -> None:
    rows = [
        detection(id=str(i), score=float(50 + i), detected_at=T0 + timedelta(minutes=i))
        for i in range(MIN_SECTION)
    ]
    for i, row in enumerate(rows):
        row.forward = {"5m": float(i)}
    sections = sections_for(rows, "5m")
    assert len(sections) == 1
    assert len(sections[0][0]) == MIN_SECTION


def test_detections_in_different_buckets_do_not_pool() -> None:
    rows = []
    for bucket in range(2):
        for i in range(MIN_SECTION):
            row = detection(
                id=f"{bucket}-{i}",
                score=float(50 + i),
                detected_at=T0 + timedelta(hours=bucket, minutes=i),
            )
            row.forward = {"5m": float(i)}
            rows.append(row)
    assert len(sections_for(rows, "5m")) == 2


def test_a_section_whose_score_is_constant_is_dropped_not_counted_as_zero() -> None:
    flat = ([50.0] * 5, [1.0, 2.0, 3.0, 4.0, 5.0])
    ranked = ([1.0, 2.0, 3.0, 4.0, 5.0], [1.0, 2.0, 3.0, 4.0, 5.0])
    result = sectional_ic([flat, ranked, ranked], "5m")
    assert result is not None
    assert result.sections == 2


def test_one_usable_section_is_not_a_distribution() -> None:
    ranked = ([1.0, 2.0, 3.0, 4.0, 5.0], [1.0, 2.0, 3.0, 4.0, 5.0])
    assert sectional_ic([ranked], "5m") is None


# ── paging ───────────────────────────────────────────────────────────────────


def test_fetch_window_pages_backwards_until_it_covers_the_start() -> None:
    series = candles([100.0 + i for i in range(2500)])
    calls: list[int] = []

    async def fake(_symbol: str, limit: int, end_time_ms: int) -> list[Candle]:
        calls.append(end_time_ms)
        cutoff = end_time_ms // 1000
        eligible = [c for c in series if c.time < cutoff]
        return eligible[-limit:]

    start = datetime.fromtimestamp(series[10].time, tz=UTC)
    end = datetime.fromtimestamp(series[-1].time, tz=UTC)
    got = asyncio.run(fetch_window("TSTUSDT", start, end, fake))

    assert len(calls) > 1
    assert got[0].time <= series[10].time
    assert [c.time for c in got] == sorted({c.time for c in got})


def test_fetch_window_stops_when_the_symbol_runs_out_of_history() -> None:
    """A newly-listed perp has nothing further back. The loop must end rather
    than ask forever."""
    series = candles([100.0, 101.0, 102.0])

    async def fake(_symbol: str, _limit: int, _end_time_ms: int) -> list[Candle]:
        return series

    got = asyncio.run(
        fetch_window("TSTUSDT", T0 - timedelta(days=30), T0 + timedelta(minutes=2), fake)
    )
    assert len(got) == 3


def test_a_symbol_with_no_history_contributes_no_rows() -> None:
    async def empty(_symbol: str, _limit: int, _end_time_ms: int) -> list[Candle]:
        return []

    rows = [detection()]
    symbols, covered = asyncio.run(attach_forward_returns(rows, empty))
    assert (symbols, covered) == (1, 0)
    assert rows[0].forward == {}


def test_one_window_serves_every_detection_on_that_symbol() -> None:
    series = candles([100.0 + i for i in range(400)])
    fetched: list[str] = []

    async def fake(symbol: str, _limit: int, _end_time_ms: int) -> list[Candle]:
        fetched.append(symbol)
        return series

    rows = [
        detection(id=str(i), detected_at=T0 + timedelta(minutes=10 * i)) for i in range(1, 6)
    ]
    symbols, covered = asyncio.run(attach_forward_returns(rows, fake))
    assert symbols == 1
    assert covered == 5
    assert len(set(fetched)) == 1


# ── assembly and rendering ───────────────────────────────────────────────────


def _report_rows() -> list[Detection]:
    rows = []
    for i in range(40):
        row = detection(
            id=str(i),
            score=float(45 + i),
            detected_at=T0 + timedelta(minutes=i),
            status="TARGET_HIT" if i % 3 == 0 else "INVALIDATED",
            gross_r=float(i) / 10.0,
            realized_r=float(i) / 10.0 - 0.2,
        )
        row.forward = {label: float(i) for label in HORIZONS}
        rows.append(row)
    return rows


def test_the_report_covers_every_horizon_and_names_the_peak() -> None:
    report = build(_report_rows(), symbols=1, covered=40, strategy_version=None)
    assert {r.horizon for r in report.price_ic} == set(HORIZONS)
    document = render(report)
    assert "|IC| peaks at" in document
    assert "Nothing here changes the live detector" in document


def test_an_unsettled_row_is_excluded_from_the_outcome_ic() -> None:
    """`NO_FILL` and open rows have no realized R. Counting their zero would
    say the score predicted a flat outcome."""
    rows = _report_rows()
    rows.append(detection(id="open", status="PENDING_ENTRY", gross_r=0.0, realized_r=0.0))
    report = build(rows, symbols=1, covered=40, strategy_version=None)
    for _, result in report.outcome_ic:
        assert result is not None
        assert result.n == 40


def test_the_report_says_so_when_no_cross_section_is_measurable() -> None:
    """The honest output when the funnel surfaces two setups an hour: the
    sectional table cannot be computed, and the pooled number carries the
    weaker claim."""
    sparse = [
        detection(id=str(i), score=float(50 + i), detected_at=T0 + timedelta(hours=i))
        for i in range(6)
    ]
    for i, row in enumerate(sparse):
        row.forward = {label: float(i) for label in HORIZONS}
    report = build(sparse, symbols=1, covered=6, strategy_version=None)
    assert report.sectional == []
    assert "No cross-section reached" in render(report)


def test_modes_are_reported_separately() -> None:
    rows = _report_rows()
    for row in rows[:20]:
        row.mode = "INTRADAY"
    report = build(rows, symbols=1, covered=40, strategy_version=None)
    assert set(report.by_mode) == {"SCALP", "INTRADAY"}
    assert "By mode" in render(report)


# ── concentration ────────────────────────────────────────────────────────────


def _carried_by_one_symbol() -> list[Detection]:
    """A book where the ordering holds only on ONESUSDT and is noise elsewhere.
    The pooled IC is positive; the jackknife must find why."""
    rows: list[Detection] = []
    for i in range(12):
        row = detection(id=f"one-{i}", symbol="ONESUSDT", score=float(50 + i))
        row.forward = {"1m": float(i)}
        rows.append(row)
    # The rest rank nothing: their returns are a fixed non-monotone pattern, so
    # they contribute noise rather than an offsetting signal.
    noise = [3.0, -1.0, 2.0, -4.0, 0.0, 1.0, -2.0, 4.0, -3.0, 2.0, -1.0, 0.0]
    for i in range(12):
        row = detection(id=f"rest-{i}", symbol=f"R{i}USDT", score=float(50 + i))
        row.forward = {"1m": noise[i]}
        rows.append(row)
    return rows


def test_the_jackknife_names_the_symbol_the_ic_rests_on() -> None:
    rows = _carried_by_one_symbol()
    result = jackknife_symbols(rows, "1m")
    assert result is not None
    full, influences = result
    assert full > 0
    assert influences[0].symbol == "ONESUSDT"
    assert influences[0].drop > 0
    assert influences[0].ic_without < full


def test_removing_the_influential_symbol_collapses_the_ic() -> None:
    rows = _carried_by_one_symbol()
    full = jackknife_symbols(rows, "1m")
    assert full is not None
    ex = ex_top_symbols_ic(rows, "1m", ["ONESUSDT"])
    assert ex is not None
    assert ex.ic < full[0] / 2


def test_a_symbol_below_the_floor_gets_no_ic_of_its_own() -> None:
    """Most symbols carry two or three detections. An IC on three points is a
    picture of three points."""
    rows = _carried_by_one_symbol()
    per = per_symbol_ic(rows, "1m")
    assert [symbol for symbol, _, _ in per] == ["ONESUSDT"]


def test_an_evenly_spread_ic_survives_every_jackknife() -> None:
    rows: list[Detection] = []
    for s in range(10):
        for i in range(4):
            row = detection(id=f"{s}-{i}", symbol=f"S{s}USDT", score=float(50 + i))
            row.forward = {"1m": float(i)}
            rows.append(row)
    result = jackknife_symbols(rows, "1m")
    assert result is not None
    full, influences = result
    assert all(inf.ic_without > 0.8 * full for inf in influences)


def test_the_report_carries_a_concentration_section() -> None:
    report = build(_report_rows(), symbols=1, covered=40, strategy_version=None)
    assert {c.horizon for c in report.concentration} == {"1m", "5m", "15m"}
    assert "Is the IC carried by a few symbols?" in render(report)
