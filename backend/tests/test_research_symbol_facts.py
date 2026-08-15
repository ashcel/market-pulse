"""Symbol facts: the onboard-date map, and the instrument fields on a snapshot.

The point of these fields is to let the record separate an edge that belongs to
a *pattern* from one that belongs to a handful of thin symbols the pattern kept
finding. That only works if the facts are frozen at detection like everything
else on the row, and if an unavailable fact reads as unknown rather than as
zero — a missing input must never look like a good one.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from smc.forward_test import open_position
from test_research_forward_test import T0, situation

from app.research.recorder import setup_values, snapshot_from, with_flow
from app.research.symbol_facts import (
    REFRESH_SECONDS,
    OnboardMap,
    parse_onboard_dates,
)

# ── the onboard map ──────────────────────────────────────────────────────────


def _payload(*rows: dict[str, object]) -> dict[str, object]:
    return {"symbols": list(rows)}


def _perp(base: str, onboard_ms: int, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "baseAsset": base,
        "quoteAsset": "USDT",
        "contractType": "PERPETUAL",
        "onboardDate": onboard_ms,
    }
    row.update(overrides)
    return row


def test_parses_usdt_perpetuals_keyed_by_base_asset() -> None:
    dates = parse_onboard_dates(_payload(_perp("BTC", 1_500_000_000_000)))
    assert dates["BTC"] == datetime.fromtimestamp(1_500_000_000, tz=UTC)


def test_tradfi_and_non_usdt_contracts_are_excluded() -> None:
    dates = parse_onboard_dates(
        _payload(
            _perp("AAPL", 1_700_000_000_000, contractType="TRADIFI_PERPETUAL"),
            _perp("BTC", 1_500_000_000_000, quoteAsset="USDC"),
            _perp("ETH", 1_600_000_000_000),
        )
    )
    assert set(dates) == {"ETH"}


def test_malformed_rows_are_skipped_rather_than_raising() -> None:
    dates = parse_onboard_dates(
        _payload(
            "not a dict",  # type: ignore[arg-type]
            _perp("A", 0),
            _perp("B", -1),
            _perp("", 1_600_000_000_000),
            _perp("OK", 1_600_000_000_000),
        )
    )
    assert set(dates) == {"OK"}


def test_a_payload_that_is_not_an_exchange_info_document_yields_nothing() -> None:
    assert parse_onboard_dates(None) == {}
    assert parse_onboard_dates({"symbols": "nope"}) == {}
    assert parse_onboard_dates([]) == {}


def test_age_is_measured_from_the_onboard_date() -> None:
    onboard = datetime.now(UTC) - timedelta(days=30)
    map_ = OnboardMap()
    map_._dates = {"NEW": onboard}

    age = map_.age_days("NEW")
    assert age is not None
    assert 29.9 < age < 30.1


def test_age_accepts_the_pair_spelling_as_well_as_the_base() -> None:
    map_ = OnboardMap()
    map_._dates = {"BTC": datetime.now(UTC) - timedelta(days=10)}

    assert map_.age_days("btc") is not None
    assert map_.age_days("BTCUSDT") is not None


def test_an_unknown_symbol_is_unknown_not_zero() -> None:
    """The whole discipline of the record in one assertion: absent is None."""
    assert OnboardMap().age_days("NOSUCH") is None


def test_age_is_taken_at_the_detection_instant_not_now() -> None:
    onboard = datetime.now(UTC) - timedelta(days=100)
    map_ = OnboardMap()
    map_._dates = {"OLD": onboard}

    detected_at = time.time() - 86400 * 40
    age = map_.age_days("OLD", detected_at)
    assert age is not None
    assert 59.9 < age < 60.1


def test_a_fresh_map_is_not_stale_and_an_unfetched_one_is() -> None:
    map_ = OnboardMap()
    assert map_.is_stale

    map_._fetched_at = time.time()
    assert not map_.is_stale

    map_._fetched_at = time.time() - REFRESH_SECONDS - 1
    assert map_.is_stale


# ── refresh keeps the last good map ──────────────────────────────────────────


class _BoomError(Exception):
    pass


async def test_a_failed_refresh_keeps_the_previous_map(monkeypatch) -> None:
    map_ = OnboardMap()
    previous = {"BTC": datetime.now(UTC) - timedelta(days=1)}
    map_._dates = dict(previous)

    async def _explode() -> dict[str, datetime]:
        raise _BoomError("binance is having a day")

    monkeypatch.setattr("app.research.symbol_facts._fetch_onboard_dates", _explode)
    assert await map_.refresh(force=True) is False
    assert map_._dates == previous


async def test_an_empty_response_never_replaces_a_good_map(monkeypatch) -> None:
    """An empty exchangeInfo is a Binance failure, not a universe of zero."""
    map_ = OnboardMap()
    previous = {"BTC": datetime.now(UTC) - timedelta(days=1)}
    map_._dates = dict(previous)

    async def _empty() -> dict[str, datetime]:
        return {}

    monkeypatch.setattr("app.research.symbol_facts._fetch_onboard_dates", _empty)
    assert await map_.refresh(force=True) is False
    assert map_._dates == previous


async def test_a_map_inside_its_refresh_window_is_not_refetched(monkeypatch) -> None:
    map_ = OnboardMap()
    calls = 0

    async def _count() -> dict[str, datetime]:
        nonlocal calls
        calls += 1
        return {"BTC": datetime.now(UTC)}

    monkeypatch.setattr("app.research.symbol_facts._fetch_onboard_dates", _count)
    assert await map_.refresh(force=True) is True
    assert await map_.refresh() is False
    assert calls == 1


# ── the fields on a snapshot ─────────────────────────────────────────────────


def _telemetry(**overrides: object) -> SimpleNamespace:
    base: dict[str, object] = dict(
        price=100.0,
        rvol_3m=2.0,
        rvol_1m=1.5,
        change_1m_pct=0.4,
        change_3m_pct=0.9,
        change_5m_pct=1.2,
        change_15m_pct=2.0,
        quote_volume_24h=12_500_000.0,
        change_24h_pct=18.5,
        trades_1m=340.0,
        volatility_1m_pct=0.25,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _frozen(**telemetry: object):
    snapshot = snapshot_from(situation(), T0)
    assert snapshot is not None
    return with_flow(snapshot, _telemetry(**telemetry))


def test_the_facts_are_read_off_the_real_telemetry_type() -> None:
    """`with_flow` reads telemetry with `getattr(..., default)`, which degrades
    silently: rename a field on `WindowMetrics` and every instrument fact
    quietly becomes 0.0 while the record keeps filling with rows that look
    complete. The duck-typed stand-in the other tests use cannot catch that, so
    this one pins the real type."""
    from smc.momentum import WindowMetrics

    metrics = WindowMetrics(
        symbol="TST",
        ts=T0,
        price=100.0,
        quote_volume_24h=9_000_000.0,
        change_24h_pct=-12.0,
        trades_1m=17.0,
        volatility_1m_pct=0.5,
    )
    snapshot = snapshot_from(situation(), T0)
    assert snapshot is not None
    frozen = with_flow(snapshot, metrics)

    assert frozen.quote_volume_24h == 9_000_000.0
    assert frozen.change_24h_pct == -12.0
    assert frozen.trades_1m == 17.0
    assert frozen.volatility_1m_pct == 0.5
    assert frozen.stop_noise_ratio is not None


def test_the_instrument_facts_ride_the_same_frame_as_the_windows() -> None:
    frozen = _frozen()
    assert frozen.quote_volume_24h == 12_500_000.0
    assert frozen.change_24h_pct == 18.5
    assert frozen.trades_1m == 340.0
    assert frozen.volatility_1m_pct == 0.25


def test_listing_age_is_none_when_the_map_has_never_been_fetched() -> None:
    """The recorder must never block on the map, so an unwarmed one is normal."""
    assert _frozen().listing_age_days is None


def test_listing_age_is_read_at_the_detection_instant(monkeypatch) -> None:
    from app.research import recorder as recorder_module

    map_ = OnboardMap()
    map_._dates = {"TST": datetime.fromtimestamp(T0 - 86400 * 7, tz=UTC)}
    monkeypatch.setattr(recorder_module, "ONBOARD_MAP", map_)

    age = _frozen().listing_age_days
    assert age is not None
    assert 6.9 < age < 7.1


def test_stop_noise_ratio_measures_the_stop_against_the_symbols_own_band() -> None:
    frozen = _frozen(volatility_1m_pct=0.25)
    ratio = frozen.stop_noise_ratio
    assert ratio is not None

    stop_pct = frozen.risk / frozen.reference_entry * 100.0
    assert ratio == pytest.approx(stop_pct / 0.25)
    # A stop worth calling one sits outside the band, not inside it.
    assert ratio > 1.0


def test_a_noisier_symbol_makes_the_same_stop_a_narrower_one() -> None:
    """The ratio is what distinguishes a 1% stop on a quiet symbol from the
    same 1% stop on one that prints that range every minute."""
    quiet = _frozen(volatility_1m_pct=0.1).stop_noise_ratio
    noisy = _frozen(volatility_1m_pct=0.4).stop_noise_ratio
    assert quiet is not None and noisy is not None
    assert quiet == pytest.approx(noisy * 4.0)


def test_stop_noise_ratio_is_unknown_without_a_noise_band() -> None:
    assert _frozen(volatility_1m_pct=None).stop_noise_ratio is None
    assert _frozen(volatility_1m_pct=0.0).stop_noise_ratio is None


def test_the_facts_are_written_into_the_row_evidence() -> None:
    frozen = _frozen()
    position, _ = open_position(frozen, T0, 100.0)
    evidence = setup_values(frozen, position, "k")["evidence"]
    assert isinstance(evidence, dict)

    assert evidence["quote_volume_24h"] == 12_500_000.0
    assert evidence["change_24h_pct"] == 18.5
    assert evidence["trades_1m"] == 340.0
    assert evidence["volatility_1m_pct"] == 0.25
    assert evidence["listing_age_days"] is None
    assert evidence["stop_noise_ratio"] == frozen.stop_noise_ratio


def test_a_resumed_row_recovers_the_facts_it_was_written_with(monkeypatch) -> None:
    """A restart must not lose them, and must not re-derive them either."""
    from app.research import recorder as recorder_module

    map_ = OnboardMap()
    map_._dates = {"TST": datetime.fromtimestamp(T0 - 86400 * 21, tz=UTC)}
    monkeypatch.setattr(recorder_module, "ONBOARD_MAP", map_)

    frozen = _frozen()
    position, _ = open_position(frozen, T0, 100.0)
    values = setup_values(frozen, position, "k")

    row = SimpleNamespace(
        **{
            key: values[key]
            for key in (
                "symbol", "market", "mode", "direction", "state", "tier", "combo",
                "score", "families", "entry_low", "entry_high", "reference_entry",
                "initial_invalidation", "target", "target_kind", "potential_rr",
                "htf_bias", "htf_agreement", "alignment", "alignment_level",
                "structure_trend", "regime", "evidence", "versions", "config_hash",
                "git_sha", "engine_version",
            )
        },
        detected_at=values["detected_at"],
    )

    restored = recorder_module.snapshot_from_row(row)
    assert restored.quote_volume_24h == frozen.quote_volume_24h
    assert restored.change_24h_pct == frozen.change_24h_pct
    assert restored.trades_1m == frozen.trades_1m
    assert restored.volatility_1m_pct == frozen.volatility_1m_pct
    assert restored.listing_age_days == pytest.approx(frozen.listing_age_days)
    assert restored.stop_noise_ratio == pytest.approx(frozen.stop_noise_ratio)


def test_a_row_written_before_these_fields_reads_back_as_unknown() -> None:
    """Back-filling an old row from today's ticker would stamp a later
    instant's fact onto an earlier detection, so it stays absent."""
    from app.research import recorder as recorder_module

    frozen = _frozen()
    position, _ = open_position(frozen, T0, 100.0)
    values = setup_values(frozen, position, "k")
    legacy = {
        k: v
        for k, v in values["evidence"].items()  # type: ignore[union-attr]
        if k
        not in {
            "quote_volume_24h",
            "change_24h_pct",
            "trades_1m",
            "volatility_1m_pct",
            "listing_age_days",
            "stop_noise_ratio",
        }
    }

    row = SimpleNamespace(
        **{
            key: values[key]
            for key in (
                "symbol", "market", "mode", "direction", "state", "tier", "combo",
                "score", "families", "entry_low", "entry_high", "reference_entry",
                "initial_invalidation", "target", "target_kind", "potential_rr",
                "htf_bias", "htf_agreement", "alignment", "alignment_level",
                "structure_trend", "regime", "versions", "config_hash",
                "git_sha", "engine_version",
            )
        },
        detected_at=values["detected_at"],
        evidence=legacy,
    )

    restored = recorder_module.snapshot_from_row(row)
    assert restored.volatility_1m_pct is None
    assert restored.listing_age_days is None
    assert restored.stop_noise_ratio is None
    assert restored.quote_volume_24h == 0.0


def test_a_snapshot_without_flow_carries_no_instrument_claim() -> None:
    """`snapshot_from` fetches nothing, so it cannot know any of this yet."""
    bare = snapshot_from(situation(), T0)
    assert bare is not None
    assert bare.quote_volume_24h == 0.0
    assert bare.volatility_1m_pct is None
    assert bare.listing_age_days is None
    assert bare.stop_noise_ratio is None
