"""Trades API round-trip tests against an ephemeral SQLite database.

The Trade model uses only portable column types, so the full
router→service→model path runs for real; only auth and the DB engine are
substituted (internal-key auth is exercised as-is via headers).
"""

from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import get_db
from app.main import app
from app.trades.models import Trade

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"
USER_B = "00000000-0000-0000-0000-00000000000b"


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


@pytest.fixture
async def trades_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    trade_table = Trade.metadata.tables["trades"]
    async with engine.begin() as conn:
        await conn.run_sync(Trade.metadata.create_all, tables=[trade_table])
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncIterator[object]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


NEW_TRADE = {
    "symbol": "btc",
    "direction": "long",
    "entry_price": 50_000.0,
    "quantity": 0.5,
    "leverage": 3,
    "strategy": "SMC Scalp",
    "notes": "test entry",
    "opened_at": "2026-07-17T00:00:00",
}


async def test_requires_auth(trades_client: AsyncClient) -> None:
    resp = await trades_client.get("/api/v1/trades/")
    assert resp.status_code == 401


async def test_rejects_bad_internal_key(trades_client: AsyncClient) -> None:
    resp = await trades_client.get(
        "/api/v1/trades/",
        headers={"x-internal-key": "wrong", "x-internal-user-id": USER_A},
    )
    assert resp.status_code == 401


async def test_create_and_list_round_trip(trades_client: AsyncClient) -> None:
    resp = await trades_client.post(
        "/api/v1/trades/", json=NEW_TRADE, headers=headers_for(USER_A)
    )
    assert resp.status_code == 201
    created = resp.json()["data"]
    assert created["symbol"] == "BTC"  # upcased by the service
    assert created["status"] == "open"
    assert created["user_id"] == USER_A
    assert created["leverage"] == 3

    resp = await trades_client.get("/api/v1/trades/", headers=headers_for(USER_A))
    assert resp.status_code == 200
    body = resp.json()
    assert body["meta"]["total"] == 1
    assert [t["id"] for t in body["data"]] == [created["id"]]

    # Other users see nothing
    resp = await trades_client.get("/api/v1/trades/", headers=headers_for(USER_B))
    assert resp.json()["meta"]["total"] == 0


async def test_status_filter(trades_client: AsyncClient) -> None:
    await trades_client.post(
        "/api/v1/trades/", json=NEW_TRADE, headers=headers_for(USER_A)
    )
    resp = await trades_client.get(
        "/api/v1/trades/", params={"status": "closed"}, headers=headers_for(USER_A)
    )
    assert resp.json()["meta"]["total"] == 0
    resp = await trades_client.get(
        "/api/v1/trades/", params={"status": "open"}, headers=headers_for(USER_A)
    )
    assert resp.json()["meta"]["total"] == 1


async def test_close_trade_via_patch(trades_client: AsyncClient) -> None:
    resp = await trades_client.post(
        "/api/v1/trades/", json=NEW_TRADE, headers=headers_for(USER_A)
    )
    trade_id = resp.json()["data"]["id"]

    resp = await trades_client.patch(
        f"/api/v1/trades/{trade_id}",
        json={
            "exit_price": 55_000.0,
            "pnl": 7_500.0,
            "pnl_percent": 30.0,
            "status": "closed",
            "closed_at": "2026-07-17T12:00:00",
        },
        headers=headers_for(USER_A),
    )
    assert resp.status_code == 200
    updated = resp.json()["data"]
    assert updated["status"] == "closed"
    assert updated["exit_price"] == 55_000.0
    assert updated["pnl"] == 7_500.0


async def test_cross_user_access_forbidden(trades_client: AsyncClient) -> None:
    resp = await trades_client.post(
        "/api/v1/trades/", json=NEW_TRADE, headers=headers_for(USER_A)
    )
    trade_id = resp.json()["data"]["id"]

    resp = await trades_client.get(
        f"/api/v1/trades/{trade_id}", headers=headers_for(USER_B)
    )
    assert resp.status_code == 403
    resp = await trades_client.delete(
        f"/api/v1/trades/{trade_id}", headers=headers_for(USER_B)
    )
    assert resp.status_code == 403


async def test_delete_then_404(trades_client: AsyncClient) -> None:
    resp = await trades_client.post(
        "/api/v1/trades/", json=NEW_TRADE, headers=headers_for(USER_A)
    )
    trade_id = resp.json()["data"]["id"]

    resp = await trades_client.delete(
        f"/api/v1/trades/{trade_id}", headers=headers_for(USER_A)
    )
    assert resp.status_code == 204
    resp = await trades_client.get(
        f"/api/v1/trades/{trade_id}", headers=headers_for(USER_A)
    )
    assert resp.status_code == 404


async def test_validation_rejects_bad_payload(trades_client: AsyncClient) -> None:
    resp = await trades_client.post(
        "/api/v1/trades/",
        json={**NEW_TRADE, "direction": "sideways"},
        headers=headers_for(USER_A),
    )
    assert resp.status_code == 422
    resp = await trades_client.post(
        "/api/v1/trades/",
        json={**NEW_TRADE, "entry_price": -1},
        headers=headers_for(USER_A),
    )
    assert resp.status_code == 422
