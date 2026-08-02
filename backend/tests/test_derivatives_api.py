"""`/api/v1/derivatives/{symbol}` and its history endpoint.

Same sqlite-backed shape as `test_signals.py`: the append-only trigger is
plpgsql and is verified against a scratch Postgres in
`test_derivatives_postgres.py`; what is covered here is auth, symbol
normalisation, the response contract and the window/metric parameters.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import get_db
from app.derivatives import repo
from app.derivatives.models import DerivativesSnapshot
from app.derivatives.router import normalize_symbol
from app.main import app

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"
AUTH = {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": USER_A}


@pytest.fixture
async def session_factory() -> AsyncIterator[Any]:
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            DerivativesSnapshot.metadata.create_all, tables=[DerivativesSnapshot.__table__]
        )
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
async def client(
    session_factory: Any, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)

    async def override_get_db() -> AsyncIterator[Any]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)


async def seed(session_factory: Any, symbol: str = "BTCUSDT", slots: int = 13) -> datetime:
    """A rising-price, rising-OI tape ending now, on the 5-minute grid.
    Returns the newest slot so a test can anchor its own window on it."""
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    rows: list[dict[str, object]] = []
    for index in range(slots):
        rows.append(
            {
                "symbol": symbol,
                "timestamp": now - timedelta(minutes=5 * (slots - 1 - index)),
                "price": 100.0 + index * 0.25,
                "open_interest": 1000.0 + index * 8,
                "open_interest_usd": (1000.0 + index * 8) * 100,
                "funding_rate": 0.00005 * (index + 1),
                "long_short_ratio": 1.2,
                "top_trader_accounts_ratio": 1.1,
                "top_trader_positions_ratio": 1.15,
                "taker_buy_volume": 74.0,
                "taker_sell_volume": 26.0,
                "basis": 0.5,
                "premium": 0.0004,
                "oi_marketcap_ratio": 0.021,
            }
        )
    async with session_factory() as session:
        await repo.insert_snapshots(session, rows)
    return now


# --- symbol normalisation ------------------------------------------------


def test_normalize_symbol_matches_the_quant_rule() -> None:
    assert normalize_symbol("btc") == "BTCUSDT"
    assert normalize_symbol("BTC") == "BTCUSDT"
    assert normalize_symbol("btcusdt") == "BTCUSDT"
    assert normalize_symbol("BTC-USDT") == "BTCUSDT"
    assert normalize_symbol("  eth ") == "ETHUSDT"


def test_normalize_symbol_rejects_an_empty_ticker() -> None:
    with pytest.raises(Exception, match="empty after normalization"):
        normalize_symbol("---")


# --- auth ----------------------------------------------------------------


async def test_requires_auth(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/derivatives/BTCUSDT")).status_code == 401


async def test_history_requires_auth(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/derivatives/BTCUSDT/history")).status_code == 401


async def test_rejects_a_wrong_internal_key(client: AsyncClient) -> None:
    resp = await client.get(
        "/api/v1/derivatives/BTCUSDT",
        headers={"x-internal-key": "wrong", "x-internal-user-id": USER_A},
    )
    assert resp.status_code == 401


# --- read model ----------------------------------------------------------


async def test_returns_every_section(client: AsyncClient, session_factory: Any) -> None:
    await seed(session_factory)
    resp = await client.get("/api/v1/derivatives/BTCUSDT", headers=AUTH)
    assert resp.status_code == 200

    body = resp.json()
    data = body["data"]
    assert set(data) == {"raw", "derived", "regime", "intelligence", "scores"}

    assert data["raw"]["symbol"] == "BTCUSDT"
    assert data["raw"]["open_interest"] == pytest.approx(1096.0)
    assert data["raw"]["oi_marketcap_ratio"] == pytest.approx(0.021)

    derived = data["derived"]
    assert set(derived["oi_delta"]) == {"5m", "15m", "1h", "24h"}
    assert derived["oi_expansion"] == "bullish_expansion"
    assert derived["buyer_aggression"] == pytest.approx(0.74)
    assert derived["crowding_band"] in {"bearish_crowded", "balanced", "bullish_crowded"}
    assert derived["sample_count"] == 13

    assert data["regime"] in {
        "strong_bull_trend",
        "weak_bull_trend",
        "strong_bear_trend",
        "weak_bear_trend",
        "short_squeeze",
        "long_squeeze",
        "distribution",
        "accumulation",
        "neutral",
    }

    scores = data["scores"]
    assert 0 <= scores["momentum"] <= 100
    assert 0 <= scores["crowding"] <= 100
    assert scores["squeeze"]["long"] + scores["squeeze"]["short"] <= 100

    intelligence = data["intelligence"]
    assert intelligence["summary"]
    assert intelligence["regime_label"]
    assert body["meta"]["samples"] == 13
    assert body["error"] is None


async def test_accepts_a_bare_ticker(client: AsyncClient, session_factory: Any) -> None:
    """The Ticket page renders `BTC`, not `BTCUSDT`."""
    await seed(session_factory)
    resp = await client.get("/api/v1/derivatives/btc", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["data"]["raw"]["symbol"] == "BTCUSDT"


async def test_unknown_symbol_is_404(client: AsyncClient, session_factory: Any) -> None:
    await seed(session_factory)
    resp = await client.get("/api/v1/derivatives/NOSUCHTOKEN", headers=AUTH)
    assert resp.status_code == 404
    error = resp.json()["error"]
    assert error["code"] == "NOT_FOUND"
    assert error["message"] == "no derivatives data collected for this symbol"
    assert error["details"]["symbol"] == "NOSUCHTOKENUSDT"


async def test_stale_symbol_is_404_with_its_own_message(
    client: AsyncClient, session_factory: Any
) -> None:
    """Collected once, long ago: a different message so an operator can tell a
    dead collector from a symbol nobody tracks."""
    async with session_factory() as session:
        await repo.insert_snapshots(
            session,
            [
                {
                    "symbol": "OLDUSDT",
                    "timestamp": datetime.now(UTC) - timedelta(days=30),
                    "open_interest": 10.0,
                }
            ],
        )
    resp = await client.get("/api/v1/derivatives/OLD", headers=AUTH)
    assert resp.status_code == 404
    assert resp.json()["error"]["message"] == "no recent derivatives snapshot for this symbol"


async def test_invalid_symbol_is_400(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/derivatives/---", headers=AUTH)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_SYMBOL"


# --- history -------------------------------------------------------------


async def test_history_defaults_to_momentum_over_one_hour(
    client: AsyncClient, session_factory: Any
) -> None:
    await seed(session_factory)
    resp = await client.get("/api/v1/derivatives/BTCUSDT/history", headers=AUTH)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["metric"] == "momentum"
    assert data["window"] == "1h"
    assert data["points"]
    assert set(data["points"][0]) == {"t", "v"}
    assert data["points"][0]["t"] < data["points"][-1]["t"]


@pytest.mark.parametrize("metric", ["momentum", "oi", "funding", "buyer_aggression"])
async def test_history_serves_every_metric(
    client: AsyncClient, session_factory: Any, metric: str
) -> None:
    await seed(session_factory)
    resp = await client.get(
        f"/api/v1/derivatives/BTCUSDT/history?metric={metric}&window=1h", headers=AUTH
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"]["metric"] == metric
    assert body["meta"]["count"] == len(body["data"]["points"])
    assert body["meta"]["count"] > 0


@pytest.mark.parametrize(("window", "expected"), [("5m", 2), ("1h", 13), ("4h", 13), ("24h", 13)])
async def test_history_windows_trim_the_series(
    client: AsyncClient, session_factory: Any, window: str, expected: int
) -> None:
    await seed(session_factory)
    resp = await client.get(
        f"/api/v1/derivatives/BTCUSDT/history?metric=oi&window={window}", headers=AUTH
    )
    assert resp.status_code == 200
    assert resp.json()["meta"]["count"] == expected


async def test_history_rejects_an_unknown_metric(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/derivatives/BTCUSDT/history?metric=vibes", headers=AUTH)
    assert resp.status_code == 422


async def test_history_rejects_an_unknown_window(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/derivatives/BTCUSDT/history?window=7d", headers=AUTH)
    assert resp.status_code == 422


async def test_history_unknown_symbol_is_404(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/derivatives/NOSUCHTOKEN/history", headers=AUTH)
    assert resp.status_code == 404


# --- repo ----------------------------------------------------------------


async def test_repo_is_idempotent_on_symbol_timestamp(session_factory: Any) -> None:
    slot = datetime.now(UTC).replace(second=0, microsecond=0)
    row: dict[str, object] = {"symbol": "BTCUSDT", "timestamp": slot, "open_interest": 10.0}
    async with session_factory() as session:
        assert await repo.insert_snapshots(session, [row]) == 1
        assert await repo.insert_snapshots(session, [dict(row)]) == 0
        assert await repo.count_since(session, "BTCUSDT", slot - timedelta(minutes=1)) == 1


async def test_repo_insert_of_nothing_is_a_no_op(session_factory: Any) -> None:
    async with session_factory() as session:
        assert await repo.insert_snapshots(session, []) == 0


async def test_repo_lists_symbols_and_reports_presence(session_factory: Any) -> None:
    await seed(session_factory, "ETHUSDT")
    async with session_factory() as session:
        assert await repo.has_symbol(session, "ETHUSDT") is True
        assert await repo.has_symbol(session, "ZZZUSDT") is False
        assert list(await repo.list_symbols(session)) == ["ETHUSDT"]


async def test_repo_load_series_is_ascending_and_windowed(session_factory: Any) -> None:
    newest = await seed(session_factory)
    async with session_factory() as session:
        series = await repo.load_series(session, "BTCUSDT", lookback_s=1800, now=newest)
        assert len(series) == 7  # 30 minutes of 5-minute slots, inclusive
        assert [point.timestamp for point in series] == sorted(point.timestamp for point in series)
