"""Bybit API-key + sync round-trip tests against an ephemeral SQLite database.

`BybitClient` network calls are monkeypatched to canned fixtures — no real
HTTP goes out. Mirrors `tests/test_trades.py`'s fixture shape: internal-key
auth via headers, dependency-overridden `get_db`.
"""

from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.bybit.client import BybitClient
from app.bybit.exceptions import BybitUpstreamError
from app.bybit.models import BybitApiKey, BybitSyncLog
from app.config import settings
from app.database import get_db
from app.main import app

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"
USER_B = "00000000-0000-0000-0000-00000000000b"


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


FIXTURE_CLOSED_PNL_ROWS: list[dict[str, Any]] = [
    {
        "orderId": "order-1",
        "symbol": "BTCUSDT",
        "side": "Sell",  # closing side -> entry was "Buy" -> LONG
        "avgEntryPrice": "50000",
        "avgExitPrice": "51000",
        "closedSize": "0.1",
        "closedPnl": "100",
        "leverage": "10",
        "openFee": "0.5",
        "closeFee": "0.5",
        "createdTime": "1700000000000",
    },
    {
        "orderId": "order-2",
        "symbol": "ETHUSDT",
        "side": "Buy",  # closing side -> entry was "Sell" -> SHORT
        "avgEntryPrice": "3000",
        "avgExitPrice": "2900",
        "closedSize": "1",
        "closedPnl": "100",
        "leverage": "5",
        "openFee": "0.2",
        "closeFee": "0.2",
        "createdTime": "1700000100000",
    },
]


async def _fake_test_connection_ok(_self: BybitClient) -> bool:
    return True


async def _fake_test_connection_fails(_self: BybitClient) -> bool:
    raise BybitUpstreamError("invalid api key", ret_code=10003)


async def _fake_get_closed_pnl(_self: BybitClient, **_kwargs: Any) -> dict[str, Any]:
    return {"list": FIXTURE_CLOSED_PNL_ROWS, "nextPageCursor": ""}


async def _fake_get_order_history(_self: BybitClient, **_kwargs: Any) -> dict[str, Any]:
    return {"list": [], "nextPageCursor": ""}


async def _fake_get_closed_pnl_fails(_self: BybitClient, **_kwargs: Any) -> dict[str, Any]:
    raise BybitUpstreamError("upstream error", ret_code=10006)


@pytest.fixture
async def bybit_client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)
    monkeypatch.setattr(BybitClient, "test_connection", _fake_test_connection_ok)
    monkeypatch.setattr(BybitClient, "get_closed_pnl", _fake_get_closed_pnl)
    monkeypatch.setattr(BybitClient, "get_order_history", _fake_get_order_history)

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    tables = [
        BybitApiKey.metadata.tables["bybit_api_keys"],
        BybitApiKey.metadata.tables["bybit_trades"],
        BybitApiKey.metadata.tables["bybit_sync_logs"],
    ]
    async with engine.begin() as conn:
        await conn.run_sync(BybitApiKey.metadata.create_all, tables=tables)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncIterator[object]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    app.state._test_session_factory = factory
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


NEW_KEY = {"api_key": "abcdefgh1234", "api_secret": "shh-do-not-leak-this-secret"}


async def test_requires_auth(bybit_client: AsyncClient) -> None:
    resp = await bybit_client.get("/api/v1/bybit/api-key")
    assert resp.status_code == 401


async def test_create_api_key_masks_secret(bybit_client: AsyncClient) -> None:
    resp = await bybit_client.post(
        "/api/v1/bybit/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    assert resp.status_code == 201
    body = resp.json()
    data = body["data"]
    assert data["api_key"] == "****1234"
    assert data["status"] == "active"
    assert "shh-do-not-leak-this-secret" not in resp.text
    assert "encrypted_secret" not in resp.text


async def test_save_api_key_rejects_invalid_credentials(
    bybit_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(BybitClient, "test_connection", _fake_test_connection_fails)
    resp = await bybit_client.post(
        "/api/v1/bybit/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BYBIT_CREDENTIALS_INVALID"


async def test_api_key_cross_user_isolation(bybit_client: AsyncClient) -> None:
    await bybit_client.post(
        "/api/v1/bybit/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    resp = await bybit_client.get("/api/v1/bybit/api-key", headers=headers_for(USER_B))
    assert resp.status_code == 404


async def test_delete_api_key_then_404(bybit_client: AsyncClient) -> None:
    await bybit_client.post(
        "/api/v1/bybit/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    resp = await bybit_client.delete("/api/v1/bybit/api-key", headers=headers_for(USER_A))
    assert resp.status_code == 204
    resp = await bybit_client.get("/api/v1/bybit/api-key", headers=headers_for(USER_A))
    assert resp.status_code == 404


async def test_sync_without_api_key_404(bybit_client: AsyncClient) -> None:
    resp = await bybit_client.post("/api/v1/bybit/sync", headers=headers_for(USER_A))
    assert resp.status_code == 404


async def test_sync_upserts_idempotently_and_log_succeeds(bybit_client: AsyncClient) -> None:
    await bybit_client.post(
        "/api/v1/bybit/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )

    resp = await bybit_client.post("/api/v1/bybit/sync", headers=headers_for(USER_A))
    assert resp.status_code == 200
    log = resp.json()["data"]
    assert log["status"] == "success"
    assert log["trades_imported"] > 0

    trades_resp = await bybit_client.get("/api/v1/bybit/trades", headers=headers_for(USER_A))
    assert trades_resp.json()["meta"]["total"] == 2  # 2 unique exchange_trade_ids

    sync_log_resp = await bybit_client.get(
        f"/api/v1/bybit/sync/{log['id']}", headers=headers_for(USER_A)
    )
    assert sync_log_resp.status_code == 200
    assert sync_log_resp.json()["data"]["status"] == "success"

    # Re-sync: same canned rows come back again -> upsert, not duplicate insert.
    resp2 = await bybit_client.post("/api/v1/bybit/sync", headers=headers_for(USER_A))
    assert resp2.status_code == 200
    assert resp2.json()["data"]["status"] == "success"

    trades_resp_2 = await bybit_client.get("/api/v1/bybit/trades", headers=headers_for(USER_A))
    assert trades_resp_2.json()["meta"]["total"] == 2  # still 2, not 4


async def test_sync_trades_cross_user_isolation(bybit_client: AsyncClient) -> None:
    await bybit_client.post(
        "/api/v1/bybit/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    await bybit_client.post("/api/v1/bybit/sync", headers=headers_for(USER_A))

    resp = await bybit_client.get("/api/v1/bybit/trades", headers=headers_for(USER_B))
    assert resp.json()["meta"]["total"] == 0


async def test_sync_log_cross_user_forbidden(bybit_client: AsyncClient) -> None:
    await bybit_client.post(
        "/api/v1/bybit/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    resp = await bybit_client.post("/api/v1/bybit/sync", headers=headers_for(USER_A))
    log_id = resp.json()["data"]["id"]

    resp = await bybit_client.get(
        f"/api/v1/bybit/sync/{log_id}", headers=headers_for(USER_B)
    )
    assert resp.status_code == 403


async def test_sync_failure_marks_log_failed(
    bybit_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await bybit_client.post(
        "/api/v1/bybit/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    monkeypatch.setattr(BybitClient, "get_closed_pnl", _fake_get_closed_pnl_fails)

    resp = await bybit_client.post("/api/v1/bybit/sync", headers=headers_for(USER_A))
    assert resp.status_code == 502

    factory = app.state._test_session_factory
    async with factory() as session:
        result = await session.execute(
            select(BybitSyncLog).where(BybitSyncLog.user_id == USER_A)
        )
        logs = list(result.scalars().all())
        assert len(logs) == 1
        assert logs[0].status == "failed"
        assert logs[0].error is not None
