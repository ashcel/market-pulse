"""macro.py has no macro.test.ts counterpart — these pin the pure reads:
date-aligned BTC↔NDX correlation, the regime bands, and the demo build.
"""

from smc.macro import (
    SeriesPoint,
    build_demo_macro_snapshot,
    compute_btc_ndx_correlation,
    correlation_regime_of,
    to_instrument,
)


def daily(closes: list[float], skip_weekends: bool) -> list[SeriesPoint]:
    """Consecutive dates in July-Aug 2026; NDX-style series skip Sat/Sun (day 4+5 of week)."""
    out: list[SeriesPoint] = []
    day = 0
    for close in closes:
        while skip_weekends and day % 7 in (4, 5):
            day += 1
        out.append(SeriesPoint(date=f"2026-{7 + day // 31:02d}-{day % 31 + 1:02d}", close=close))
        day += 1
    return out


def test_correlation_is_1_for_identical_returns_on_shared_dates() -> None:
    closes = [100 * (1 + 0.01 * ((i * 7) % 5 - 2)) for i in range(40)]
    ndx = daily(closes, skip_weekends=True)
    # BTC trades every day; on NDX's dates it prints the same closes.
    btc = [SeriesPoint(date=p.date, close=p.close) for p in ndx]
    assert compute_btc_ndx_correlation(btc, ndx) == 1


def test_correlation_aligns_on_shared_dates_so_weekends_never_read_as_divergence() -> None:
    closes = [100.0 + (i % 7) for i in range(40)]
    ndx = daily(closes, skip_weekends=True)
    btc = [SeriesPoint(date=p.date, close=p.close) for p in ndx]
    # Add BTC weekend bars NDX never sees — they must not affect the read.
    btc_with_weekends = [*btc, SeriesPoint(date="2026-06-06", close=1.0)]
    assert compute_btc_ndx_correlation(btc_with_weekends, ndx) == compute_btc_ndx_correlation(
        btc, ndx
    )


def test_correlation_is_none_below_the_shared_session_floor() -> None:
    ndx = daily([100 + i for i in range(8)], skip_weekends=False)
    btc = [SeriesPoint(date=p.date, close=p.close * 2) for p in ndx]
    assert compute_btc_ndx_correlation(btc, ndx) is None
    assert compute_btc_ndx_correlation([], []) is None


def test_correlation_regime_bands() -> None:
    assert correlation_regime_of(None) is None
    assert correlation_regime_of(0.4) == "coupled"
    assert correlation_regime_of(0.39) == "decoupled"
    assert correlation_regime_of(-0.29) == "decoupled"
    assert correlation_regime_of(-0.3) == "inverse"


def test_to_instrument_reads_last_close_change_and_spark() -> None:
    series = daily([100.0, 102.0, 104.04], skip_weekends=False)
    instrument = to_instrument("spx", series)
    assert instrument.label == "S&P 500"
    assert instrument.last == 104.04
    assert instrument.change_percent == 2
    assert instrument.spark == [100, 102, 104.04]


def test_demo_macro_snapshot_is_deterministic_and_labeled_demo() -> None:
    a = build_demo_macro_snapshot()
    b = build_demo_macro_snapshot()
    assert a.source == "demo"
    assert a.instruments == b.instruments
    assert [i.id for i in a.instruments] == ["spx", "ndx", "dxy", "gold"]
    assert a.btc_ndx_correlation == b.btc_ndx_correlation
    assert a.correlation_regime == correlation_regime_of(a.btc_ndx_correlation)
    for instrument in a.instruments:
        assert instrument.last > 0
        assert len(instrument.spark) == 30
