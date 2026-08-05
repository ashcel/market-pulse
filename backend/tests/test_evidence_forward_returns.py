"""V1-T1 — the no-lookahead guarantee, plus the arithmetic it protects.

The lookahead tests are the point of this file. Every Information Coefficient
the product will ever report is a rank correlation against these rows, so a
forward return that peeks at a bar which had not printed yet would inflate
every downstream statistic invisibly and permanently.
"""

from datetime import UTC, datetime, timedelta

import pytest
from smc.types import Candle

from app.evidence.constants import HORIZONS, MAX_HORIZON_BARS
from app.evidence.forward_returns import compute_forward_returns

#: `Candle.time` is a SECOND epoch labelling the bar's OPEN — see
#: `app.worker.binance._parse_klines`. The fixture uses the real unit so a
#: regression back to milliseconds fails here rather than in production.
HOUR_S = 3_600

#: A real 2026 open time, so a unit slip lands in 1970 and is visible.
BASE_TIME = 1_780_000_000


def _candles(closes: list[float], start_s: int = BASE_TIME) -> list[Candle]:
    """Ascending hourly candles whose close is the only meaningful field."""
    return [
        Candle(
            time=start_s + i * HOUR_S,
            open=close,
            high=close,
            low=close,
            close=close,
            volume=1.0,
        )
        for i, close in enumerate(closes)
    ]


# ---------------------------------------------------------------------------
# No lookahead — the guarantee the whole evidence plane rests on.
# ---------------------------------------------------------------------------


def test_no_row_is_emitted_for_a_future_that_has_not_happened() -> None:
    """With exactly one bar past the anchor, only the 1h horizon is knowable."""
    candles = _candles([100.0, 110.0])

    rows = compute_forward_returns("BTCUSDT", candles)

    assert [r.horizon for r in rows] == ["1h"]
    # Anchored to the bar's CLOSE: open time plus one interval.
    assert rows[0].observed_at == datetime.fromtimestamp(BASE_TIME + HOUR_S, tz=UTC)


def test_the_final_bar_never_produces_a_row() -> None:
    """Nothing follows the last bar, so it can anchor no measurement."""
    candles = _candles([100.0] * 10)
    last_time = datetime.fromtimestamp(candles[-1].time + HOUR_S, tz=UTC)

    rows = compute_forward_returns("BTCUSDT", candles)

    assert all(r.observed_at != last_time for r in rows)


def test_every_row_measures_forward_from_its_own_anchor() -> None:
    """The structural check: for each row, the forward close must be the close
    of the bar exactly `horizon_bars` after the anchor — never before it, and
    never a different bar."""
    closes = [100.0 + i for i in range(MAX_HORIZON_BARS + 30)]
    candles = _candles(closes)
    by_time = {datetime.fromtimestamp(c.time + HOUR_S, tz=UTC): i for i, c in enumerate(candles)}

    rows = compute_forward_returns("BTCUSDT", candles)

    assert rows, "fixture must be long enough to produce rows"
    for row in rows:
        anchor = by_time[row.observed_at]
        target = anchor + row.horizon_bars
        assert target > anchor, "the measured bar must be strictly in the future"
        assert target < len(closes), "the measured bar must already exist"
        assert row.base_close == closes[anchor]
        assert row.forward_close == closes[target]


def test_truncating_the_series_never_changes_a_surviving_row() -> None:
    """Recomputation on a shorter window must reproduce identical numbers —
    which is what makes the writer's ON CONFLICT DO NOTHING safe."""
    closes = [100.0 * (1.01**i) for i in range(MAX_HORIZON_BARS + 40)]
    full = compute_forward_returns("BTCUSDT", _candles(closes))
    truncated = compute_forward_returns("BTCUSDT", _candles(closes[:-10]))

    full_index = {(r.observed_at, r.horizon): r.forward_return for r in full}
    for row in truncated:
        assert full_index[(row.observed_at, row.horizon)] == pytest.approx(row.forward_return)


# ---------------------------------------------------------------------------
# Arithmetic and shape.
# ---------------------------------------------------------------------------


def test_forward_return_is_a_simple_return() -> None:
    candles = _candles([100.0, 110.0])

    (row,) = compute_forward_returns("BTCUSDT", candles)

    assert row.forward_return == pytest.approx(0.10)
    assert row.base_close == 100.0
    assert row.forward_close == 110.0


def test_a_fall_returns_a_negative_number() -> None:
    candles = _candles([100.0, 75.0])

    (row,) = compute_forward_returns("BTCUSDT", candles)

    assert row.forward_return == pytest.approx(-0.25)


def test_all_six_horizons_appear_once_the_series_is_long_enough() -> None:
    candles = _candles([100.0] * (MAX_HORIZON_BARS + 2))

    rows = compute_forward_returns("BTCUSDT", candles)
    first_close = datetime.fromtimestamp(BASE_TIME + HOUR_S, tz=UTC)
    first_bar = [r for r in rows if r.observed_at == first_close]

    assert {r.horizon for r in first_bar} == set(HORIZONS)
    assert [r.horizon_bars for r in first_bar] == sorted(HORIZONS.values())


def test_rows_carry_the_interval_and_version_they_were_computed_under() -> None:
    from app.evidence.constants import BASE_INTERVAL, FORWARD_RETURN_VERSION

    (row,) = compute_forward_returns("BTCUSDT", _candles([100.0, 101.0]))

    assert row.interval == BASE_INTERVAL
    assert row.version == FORWARD_RETURN_VERSION
    assert row.symbol == "BTCUSDT"


# ---------------------------------------------------------------------------
# Degenerate input — skipped, never invented.
# ---------------------------------------------------------------------------


def test_too_short_a_series_yields_nothing() -> None:
    assert compute_forward_returns("BTCUSDT", []) == []
    assert compute_forward_returns("BTCUSDT", _candles([100.0])) == []


def test_a_non_positive_base_close_is_skipped_not_divided_by() -> None:
    """A zero close would make the return infinite and a negative one would
    flip its sign. Both are data faults, so the bar is dropped."""
    candles = _candles([0.0, 100.0, 110.0])

    rows = compute_forward_returns("BTCUSDT", candles)

    assert all(r.base_close > 0 for r in rows)
    # Only the 100.0 bar (index 1) can anchor; its close is at index-1 open + 1h.
    assert {r.observed_at for r in rows} == {
        datetime.fromtimestamp(BASE_TIME + 2 * HOUR_S, tz=UTC)
    }


def test_a_custom_horizon_map_is_honoured() -> None:
    candles = _candles([100.0, 110.0, 121.0])

    rows = compute_forward_returns("BTCUSDT", candles, horizons={"2h": 2})

    assert [r.horizon for r in rows] == ["2h"]
    assert rows[0].forward_return == pytest.approx(0.21)


def test_observed_at_is_a_plausible_wall_clock_instant() -> None:
    """The regression guard for the bug this file's first version shipped:
    `Candle.time` was read as milliseconds when it is seconds, which put every
    `observed_at` in January 1970. Index arithmetic stayed correct, so no other
    test noticed — only the stored timestamps were wrong, and they are the
    join key the IC pass would have used."""
    candles = _candles([100.0, 110.0])

    (row,) = compute_forward_returns("BTCUSDT", candles)

    assert row.observed_at.year >= 2020, "a unit slip lands the anchor in 1970"
    assert row.observed_at == datetime.fromtimestamp(candles[0].time, tz=UTC) + timedelta(
        seconds=HOUR_S
    )
