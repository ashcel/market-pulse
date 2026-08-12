"""Feed transport: websocket frame handling, and the REST polling fallback.

The production VPS cannot receive Binance futures stream frames (the socket
opens and stays silent), so the REST path is not a theoretical fallback — it is
the transport the radar actually runs on there. It gets the same coverage as
the websocket path.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from smc.discovery import Ticker24h

from app.momentum import config as cfg
from app.momentum import ingestor as ingestor_module
from app.momentum.ingestor import MomentumIngestor
from app.momentum.state import MarketStateStore

T0 = 1_700_000_000.0


def ws_payload(**overrides: object) -> str:
    row: dict[str, object] = {
        "e": "24hrTicker",
        "E": int(T0 * 1000),
        "s": "TSTUSDT",
        "c": "100.0",
        "q": "18500000.0",
        "n": 90_000,
        "P": "12.0",
    }
    row.update(overrides)
    return json.dumps([row])


def ticker(ticker_name: str = "TST", **overrides: float) -> Ticker24h:
    values: dict[str, float] = {
        "last_price": 100.0,
        "change_percent24h": 12.0,
        "high_price": 105.0,
        "low_price": 95.0,
        "weighted_avg_price": 100.0,
        "quote_volume24h": 18_500_000.0,
        "trades24h": 90_000.0,
    }
    values.update(overrides)
    return Ticker24h(ticker=ticker_name, **values)  # type: ignore[arg-type]


# ── websocket frame handling ─────────────────────────────────────────────────


def test_handles_a_bare_stream_frame() -> None:
    store = MarketStateStore()
    MomentumIngestor(store)._handle(ws_payload())
    assert store.symbols() == ["TST"]


def test_handles_a_combined_stream_envelope() -> None:
    """`/stream?streams=` wraps the payload in `{stream, data}`; both forms are
    accepted so `MOMENTUM_WS_URL` can point at either."""
    store = MarketStateStore()
    envelope = json.dumps({"stream": "!ticker@arr", "data": json.loads(ws_payload())})
    MomentumIngestor(store)._handle(envelope)
    assert store.symbols() == ["TST"]


def test_malformed_frames_are_ignored() -> None:
    store = MarketStateStore()
    ingestor = MomentumIngestor(store)
    ingestor._handle("{not json")
    ingestor._handle(json.dumps({"stream": "x", "data": "nonsense"}))
    ingestor._handle(json.dumps([]))
    assert len(store) == 0
    assert store.frames_ingested == 0


# ── REST polling fallback ────────────────────────────────────────────────────


async def test_rest_loop_ingests_the_whole_market_in_one_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_fetch() -> list[Ticker24h]:
        nonlocal calls
        calls += 1
        return [ticker("TST"), ticker("ETH", last_price=3000.0)]

    monkeypatch.setattr(ingestor_module, "fetch_perp_ticker_24h_all", fake_fetch)
    monkeypatch.setattr(cfg, "REST_POLL_SECONDS", 0.01)

    store = MarketStateStore()
    ingestor = MomentumIngestor(store)
    task = asyncio.create_task(ingestor._rest_loop())
    await asyncio.sleep(0.05)
    # `stop()` clears `connected`, so read it while the loop is still live.
    connected = ingestor.connected
    await ingestor.stop()
    task.cancel()

    assert calls >= 1
    assert sorted(store.symbols()) == ["ETH", "TST"]
    assert connected is True


async def test_rest_loop_applies_the_liquidity_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_fetch() -> list[Ticker24h]:
        return [
            ticker("TST"),
            ticker("DEAD", quote_volume24h=cfg.MIN_QUOTE_VOLUME_24H - 1),
            ticker("ZERO", last_price=0.0),
        ]

    monkeypatch.setattr(ingestor_module, "fetch_perp_ticker_24h_all", fake_fetch)
    monkeypatch.setattr(cfg, "REST_POLL_SECONDS", 0.01)

    store = MarketStateStore()
    ingestor = MomentumIngestor(store)
    task = asyncio.create_task(ingestor._rest_loop())
    await asyncio.sleep(0.05)
    await ingestor.stop()
    task.cancel()

    assert store.symbols() == ["TST"]


async def test_rest_loop_survives_a_failed_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed fetch must not kill the feed — it degrades to disconnected and
    keeps trying, like every other fetcher in the Binance plane."""
    attempts = 0

    async def flaky() -> list[Ticker24h]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("boom")
        return [ticker("TST")]

    monkeypatch.setattr(ingestor_module, "fetch_perp_ticker_24h_all", flaky)
    monkeypatch.setattr(cfg, "REST_POLL_SECONDS", 0.01)

    store = MarketStateStore()
    ingestor = MomentumIngestor(store)
    task = asyncio.create_task(ingestor._rest_loop())
    await asyncio.sleep(0.08)
    await ingestor.stop()
    task.cancel()

    assert attempts >= 2
    assert store.symbols() == ["TST"]
    assert ingestor.last_error is None


# ── transport selection ──────────────────────────────────────────────────────


async def test_auto_mode_falls_back_to_rest_when_the_probe_gets_no_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cfg, "FEED_MODE", "auto")
    monkeypatch.setattr(cfg, "REST_POLL_SECONDS", 0.01)

    async def fake_fetch() -> list[Ticker24h]:
        return [ticker("TST")]

    monkeypatch.setattr(ingestor_module, "fetch_perp_ticker_24h_all", fake_fetch)

    store = MarketStateStore()
    ingestor = MomentumIngestor(store)
    monkeypatch.setattr(ingestor, "_websocket_delivers", lambda: _false())

    task = asyncio.create_task(ingestor._run())
    await asyncio.sleep(0.05)
    await ingestor.stop()
    task.cancel()

    assert ingestor.mode == "rest"
    assert store.symbols() == ["TST"]


async def test_feed_mode_can_be_pinned(monkeypatch: pytest.MonkeyPatch) -> None:
    """`MOMENTUM_FEED=rest` skips the probe entirely."""
    probed = False

    async def probe() -> bool:
        nonlocal probed
        probed = True
        return True

    async def fake_fetch() -> list[Ticker24h]:
        return [ticker("TST")]

    monkeypatch.setattr(cfg, "FEED_MODE", "rest")
    monkeypatch.setattr(cfg, "REST_POLL_SECONDS", 0.01)
    monkeypatch.setattr(ingestor_module, "fetch_perp_ticker_24h_all", fake_fetch)

    store = MarketStateStore()
    ingestor = MomentumIngestor(store)
    monkeypatch.setattr(ingestor, "_websocket_delivers", probe)

    task = asyncio.create_task(ingestor._run())
    await asyncio.sleep(0.05)
    await ingestor.stop()
    task.cancel()

    assert ingestor.mode == "rest"
    assert probed is False


async def _false() -> bool:
    return False
