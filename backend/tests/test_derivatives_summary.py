"""`/api/v1/derivatives/summary` — the cross-symbol read model.

Same sqlite-backed shape as `test_derivatives_api.py`. What matters here is
that the route is registered ahead of `/{symbol}` (so `summary` isn't treated
as a ticker), that an empty table degrades to empty lists rather than a
crash, and that the response carries the finished labels (`regime_label`,
`squeeze_label`) rather than a bare enum.
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


async def seed_trending(
    session_factory: Any, symbol: str, *, price_step: float, oi_step: float, slots: int = 13
) -> None:
    """A tape trending in one direction — `price_step`/`oi_step` set the sign,
    which is all the summary rankings (momentum, OI delta, squeeze) actually
    read."""
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    rows: list[dict[str, object]] = []
    for index in range(slots):
        rows.append(
            {
                "symbol": symbol,
                "timestamp": now - timedelta(minutes=5 * (slots - 1 - index)),
                "price": 100.0 + index * price_step,
                "open_interest": 1000.0 + index * oi_step,
                "funding_rate": 0.0002,
                "long_short_ratio": 1.8,
                "top_trader_accounts_ratio": 1.6,
                "top_trader_positions_ratio": 1.6,
                "taker_buy_volume": 80.0,
                "taker_sell_volume": 20.0,
                "premium": 0.0003,
            }
        )
    async with session_factory() as session:
        await repo.insert_snapshots(session, rows)


# --- auth ------------------------------------------------------------------


async def test_requires_auth(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/derivatives/summary")).status_code == 401


async def test_rejects_a_wrong_internal_key(client: AsyncClient) -> None:
    resp = await client.get(
        "/api/v1/derivatives/summary",
        headers={"x-internal-key": "wrong", "x-internal-user-id": USER_A},
    )
    assert resp.status_code == 401


# --- empty table -------------------------------------------------------------


async def test_empty_snapshot_table_is_empty_lists_not_a_crash(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/derivatives/summary", headers=AUTH)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["top_momentum"] == []
    assert data["top_squeeze"] == []
    assert data["top_oi_gainers"] == []
    assert data["top_oi_losers"] == []
    assert data["regime_distribution"] == []
    assert data["symbols_covered"] == 0
    assert resp.json()["error"] is None


# --- shape + ranking -----------------------------------------------------


async def test_returns_every_section_with_finished_labels(
    client: AsyncClient, session_factory: Any
) -> None:
    await seed_trending(session_factory, "BTCUSDT", price_step=0.5, oi_step=10)
    await seed_trending(session_factory, "ETHUSDT", price_step=-0.5, oi_step=10)

    resp = await client.get("/api/v1/derivatives/summary", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    data = body["data"]
    assert set(data) == {
        "top_momentum",
        "top_squeeze",
        "top_oi_gainers",
        "top_oi_losers",
        "regime_distribution",
        "symbols_covered",
    }
    assert data["symbols_covered"] == 2
    assert body["meta"]["symbols_scanned"] == 2

    assert len(data["top_momentum"]) == 2
    for entry in data["top_momentum"]:
        assert set(entry) == {"symbol", "momentum", "regime", "regime_label"}
        assert entry["regime_label"]
    momentum_values = [entry["momentum"] for entry in data["top_momentum"]]
    assert momentum_values == sorted(momentum_values, reverse=True)

    for entry in data["top_squeeze"]:
        assert set(entry) == {"symbol", "squeeze", "dominant_side", "squeeze_label"}
        assert entry["dominant_side"] in {"long", "short"}

    gainer_symbols = {entry["symbol"] for entry in data["top_oi_gainers"]}
    loser_symbols = {entry["symbol"] for entry in data["top_oi_losers"]}
    assert gainer_symbols.isdisjoint(loser_symbols)
    for entry in [*data["top_oi_gainers"], *data["top_oi_losers"]]:
        assert set(entry) == {"symbol", "oi_delta_pct", "regime", "regime_label"}

    assert len(data["regime_distribution"]) >= 1
    total_regime_count = sum(row["count"] for row in data["regime_distribution"])
    assert total_regime_count == 2
    for row in data["regime_distribution"]:
        assert set(row) == {"regime", "regime_label", "count"}


async def test_summary_is_registered_ahead_of_the_symbol_route(
    client: AsyncClient, session_factory: Any  # noqa: ARG001 — fixture builds the schema
) -> None:
    """`/derivatives/summary` must resolve to this endpoint, not be swallowed
    by `/{symbol}` as a ticker literally named SUMMARY."""
    resp = await client.get("/api/v1/derivatives/summary", headers=AUTH)
    assert resp.status_code == 200
    assert "top_momentum" in resp.json()["data"]


async def test_stale_symbol_is_excluded_gracefully(
    client: AsyncClient, session_factory: Any
) -> None:
    """A symbol collected once, long ago, must not 500 the summary — it's
    just outside the read lookback and gets dropped, same as `/{symbol}`
    treats it as unknown."""
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
    resp = await client.get("/api/v1/derivatives/summary", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["data"]["symbols_covered"] == 0
