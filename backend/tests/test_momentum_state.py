"""In-memory market state store + rolling-window aggregator.

These cover the half of the radar the pure engine cannot: frame parsing, the
24h-counter-difference approximation for window volume, baseline selection
(observed vs the cold-start prior), and warm-up honesty.
"""

from __future__ import annotations

import pytest

from app.momentum import config as cfg
from app.momentum.state import (
    MarketStateStore,
    SymbolState,
    TickerFrame,
    parse_ticker_array,
    parse_ticker_frame,
)

T0 = 1_700_000_000.0


def row(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "e": "24hrTicker",
        "E": int(T0 * 1000),
        "s": "TSTUSDT",
        "c": "100.0",
        "q": "18500000.0",
        "n": 90_000,
        "P": "12.0",
    }
    base.update(overrides)
    return base


# ── frame parsing ────────────────────────────────────────────────────────────


def test_parses_a_well_formed_row() -> None:
    frame = parse_ticker_frame(row())
    assert frame is not None
    assert frame.symbol == "TST"
    assert frame.price == 100.0
    assert frame.quote_volume_24h == 18_500_000.0
    assert frame.trades_24h == 90_000.0


def test_canonicalizes_the_futures_only_base_rename() -> None:
    frame = parse_ticker_frame(row(s="1000PEPEUSDT"))
    assert frame is not None
    assert frame.symbol == "PEPE"


def test_rejects_non_usdt_malformed_and_illiquid_rows() -> None:
    assert parse_ticker_frame(row(s="BTCUSDC")) is None
    assert parse_ticker_frame(row(s="USDT")) is None
    assert parse_ticker_frame(row(c="not-a-number")) is None
    assert parse_ticker_frame(row(c="0")) is None
    assert parse_ticker_frame({"s": "TSTUSDT"}) is None
    assert parse_ticker_frame("nonsense") is None
    assert parse_ticker_frame(row(q=str(cfg.MIN_QUOTE_VOLUME_24H - 1))) is None


def test_parse_array_skips_bad_rows_without_failing_the_frame() -> None:
    frames = parse_ticker_array([row(), {"broken": True}, row(s="ETHUSDT")])
    assert [f.symbol for f in frames] == ["TST", "ETH"]
    assert parse_ticker_array({"not": "a list"}) == []


# ── window aggregation ───────────────────────────────────────────────────────


def feed(
    state: SymbolState,
    *,
    start: float = T0,
    seconds: int,
    price: object,
    volume_per_second: float = 100.0,
    trades_per_second: float = 1.0,
    base_volume: float = 8_640_000.0,
    base_trades: float = 86_400.0,
) -> None:
    """Drives one second of samples at a time. `price` is either a constant or
    a callable of elapsed seconds. The 24h counters start at a value consistent
    with the per-second rate (100/s -> 6000/min -> 8.64M/24h) so the cold-start
    prior lines up with the tape being fed."""
    for step in range(seconds + 1):
        now = start + step
        value = price(step) if callable(price) else price
        state.ingest(
            TickerFrame(
                symbol=state.symbol,
                price=float(value),
                quote_volume_24h=base_volume + volume_per_second * step,
                trades_24h=base_trades + trades_per_second * step,
                change_24h_pct=5.0,
                event_ts=now,
            ),
            now,
        )


def test_price_windows_are_measured_against_the_observed_series() -> None:
    state = SymbolState(symbol="TST")
    # Flat at 100 for 10 minutes, then +2% over the final minute.
    feed(state, seconds=600, price=100.0)
    feed(state, start=T0 + 601, seconds=60, price=lambda s: 100.0 + 2.0 * (s / 60.0))

    metrics = state.metrics(T0 + 661, cfg.load_detector_config())
    assert metrics is not None
    assert metrics.change_1m_pct == pytest.approx(2.0, abs=0.1)
    assert metrics.change_3m_pct == pytest.approx(2.0, abs=0.1)
    assert metrics.warming_up is False


def test_windows_are_none_until_the_buffer_reaches_back_that_far() -> None:
    state = SymbolState(symbol="TST")
    feed(state, seconds=400, price=100.0)
    metrics = state.metrics(T0 + 400, cfg.load_detector_config())
    assert metrics is not None
    assert metrics.change_1m_pct is not None
    assert metrics.change_5m_pct is not None
    assert metrics.change_15m_pct is None
    # Only a missing 3m window (or missing volume) counts as warming up.
    assert metrics.warming_up is False


def test_warming_up_until_the_three_minute_window_exists() -> None:
    state = SymbolState(symbol="TST")
    feed(state, seconds=30, price=100.0)
    metrics = state.metrics(T0 + 30, cfg.load_detector_config())
    assert metrics is not None and metrics.warming_up is True


def test_relative_volume_detects_a_burst_against_the_observed_baseline() -> None:
    state = SymbolState(symbol="TST")
    # 20 minutes of steady tape, then a minute at 5x.
    feed(state, seconds=1200, price=100.0, volume_per_second=100.0)
    quiet = state.metrics(T0 + 1200, cfg.load_detector_config())
    assert quiet is not None
    assert quiet.rvol_1m == pytest.approx(1.0, abs=0.05)

    last = state.quote_volume[-1]
    for step in range(1, 61):
        now = T0 + 1200 + step
        state.ingest(
            TickerFrame(
                symbol="TST",
                price=100.0,
                quote_volume_24h=last + 500.0 * step,
                trades_24h=86_400.0 + 1200.0 + 5.0 * step,
                change_24h_pct=5.0,
                event_ts=now,
            ),
            now,
        )
    burst = state.metrics(T0 + 1260, cfg.load_detector_config())
    assert burst is not None
    assert burst.rvol_1m == pytest.approx(5.0, rel=0.15)
    assert burst.trade_rate_mult == pytest.approx(5.0, rel=0.15)
    # The burst must not have inflated its own baseline.
    assert burst.rvol_3m is not None and burst.rvol_3m > 1.5


def test_cold_start_falls_back_to_the_twenty_four_hour_prior() -> None:
    """Before the baseline window is deep enough, relative volume is measured
    against `quoteVolume24h / 1440` — available on the very first frame, so the
    radar is never blind."""
    state = SymbolState(symbol="TST")
    # 1440 minutes' worth implies 1000/min; feed exactly that for two minutes.
    feed(state, seconds=120, price=100.0, volume_per_second=1000.0 / 60.0)
    state.quote_volume_24h = 1_440_000.0
    metrics = state.metrics(T0 + 120, cfg.load_detector_config())
    assert metrics is not None
    assert metrics.rvol_1m == pytest.approx(1.0, abs=0.05)


def test_window_extremes_anchor_the_impulse_leg() -> None:
    state = SymbolState(symbol="TST")
    feed(state, seconds=300, price=lambda s: 100.0 + s / 30.0)
    metrics = state.metrics(T0 + 300, cfg.load_detector_config())
    assert metrics is not None
    assert metrics.window_high == pytest.approx(110.0)
    assert metrics.window_low == pytest.approx(100.0, abs=0.2)


def test_volatility_expansion_reads_current_range_against_its_ewma() -> None:
    state = SymbolState(symbol="TST")
    # Ten quiet minutes (±0.1%), then a minute swinging ±1%.
    feed(state, seconds=600, price=lambda s: 100.0 + (0.1 if s % 2 else 0.0))
    feed(state, start=T0 + 601, seconds=60, price=lambda s: 100.0 + (1.0 if s % 2 else 0.0))
    metrics = state.metrics(T0 + 661, cfg.load_detector_config())
    assert metrics is not None
    assert metrics.range_expansion is not None
    assert metrics.range_expansion > 3.0


def test_last_meaningful_ts_tracks_tape_not_tick_arrival() -> None:
    detector = cfg.load_detector_config()
    state = SymbolState(symbol="TST")
    feed(state, seconds=600, price=100.0)
    quiet = state.metrics(T0 + 600, detector)
    assert quiet is not None
    # A flat tape never advances the meaningful clock, however many ticks land.
    assert state.last_meaningful_ts == 0.0

    feed(state, start=T0 + 601, seconds=60, price=lambda s: 100.0 + s / 60.0)
    state.metrics(T0 + 661, detector)
    assert state.last_meaningful_ts == T0 + 661


def test_samples_are_trimmed_to_the_retention_horizon() -> None:
    state = SymbolState(symbol="TST")
    feed(state, seconds=int(cfg.HISTORY_SECONDS) + 600, price=100.0)
    assert len(state.ts) <= cfg.HISTORY_SECONDS + 400
    assert state.ts[-1] == T0 + cfg.HISTORY_SECONDS + 600


def test_sub_second_frames_do_not_oversample() -> None:
    state = SymbolState(symbol="TST")
    for step in range(20):
        now = T0 + step * 0.1
        state.ingest(
            TickerFrame("TST", 100.0, 1_000_000.0, 10_000.0, 5.0, now),
            now,
        )
    assert len(state.ts) <= 3


# ── store ────────────────────────────────────────────────────────────────────


def test_store_creates_and_reuses_symbol_state() -> None:
    store = MarketStateStore()
    frames = parse_ticker_array([row(), row(s="ETHUSDT")])
    store.ingest_batch(frames, T0)
    store.ingest_batch(frames, T0 + 1)
    assert len(store) == 2
    assert sorted(store.symbols()) == ["ETH", "TST"]
    assert store.frames_ingested == 2
    assert store.last_frame_ts == T0 + 1
    assert store.get("TST") is not None
    assert store.get("NOPE") is None


def test_store_snapshot_returns_one_metrics_row_per_symbol() -> None:
    store = MarketStateStore()
    for step in range(200):
        store.ingest_batch(parse_ticker_array([row(), row(s="ETHUSDT")]), T0 + step)
    snapshot = store.snapshot_metrics(T0 + 200)
    assert {m.symbol for m in snapshot} == {"TST", "ETH"}
