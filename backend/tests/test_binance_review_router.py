"""Binance Trade-Review API-key + sync round-trip tests against an ephemeral
SQLite database.

`BinanceExecClient` network calls are monkeypatched to canned fixtures — no
real HTTP goes out. Mirrors the (now-superseded) `tests/test_bybit_router.py`
fixture shape: internal-key auth via headers, dependency-overridden `get_db`.
"""

from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.binance_review.exceptions import BinanceReviewUpstreamError
from app.binance_review.models import BinanceReviewKey, BinanceReviewSyncLog
from app.config import settings
from app.database import get_db
from app.execution.binance_client import BinanceExecClient
from app.main import app

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"
USER_B = "00000000-0000-0000-0000-00000000000b"


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


FIXTURE_INCOME_ROWS: list[dict[str, Any]] = [
    {
        "symbol": "BTCUSDT",
        "incomeType": "REALIZED_PNL",
        "income": "100",
        "time": 1700000060000,
        "tranId": 9001,
        "tradeId": "1001",
    },
    {
        "symbol": "ETHUSDT",
        "incomeType": "REALIZED_PNL",
        "income": "50",
        "time": 1700000120000,
        "tranId": 9002,
        "tradeId": "2001",
    },
]

BTC_USER_TRADES: list[dict[str, Any]] = [
    {
        "symbol": "BTCUSDT",
        "id": 1000,
        "orderId": 5000,
        "side": "BUY",
        "price": "50000",
        "qty": "0.1",
        "realizedPnl": "0",
        "commission": "0.05",
        "commissionAsset": "USDT",
        "time": 1700000000000,
    },
    {
        "symbol": "BTCUSDT",
        "id": 1001,
        "orderId": 5001,
        "side": "SELL",
        "price": "51000",
        "qty": "0.1",
        "realizedPnl": "100",
        "commission": "0.05",
        "commissionAsset": "USDT",
        "time": 1700000060000,
    },
]

ETH_USER_TRADES: list[dict[str, Any]] = [
    {
        "symbol": "ETHUSDT",
        "id": 2000,
        "orderId": 6000,
        "side": "SELL",
        "price": "3000",
        "qty": "1",
        "realizedPnl": "0",
        "commission": "0.2",
        "commissionAsset": "USDT",
        "time": 1700000090000,
    },
    {
        "symbol": "ETHUSDT",
        "id": 2001,
        "orderId": 6001,
        "side": "BUY",
        "price": "2950",
        "qty": "1",
        "realizedPnl": "50",
        "commission": "0.2",
        "commissionAsset": "USDT",
        "time": 1700000120000,
    },
]

BTC_ORDERS: list[dict[str, Any]] = [
    {
        "orderId": 5001,
        "symbol": "BTCUSDT",
        "type": "STOP_MARKET",
        "stopPrice": "50900",
        "status": "FILLED",
    },
]

ETH_ORDERS: list[dict[str, Any]] = [
    {
        "orderId": 6001,
        "symbol": "ETHUSDT",
        "type": "MARKET",
        "stopPrice": "0",
        "status": "FILLED",
    },
]


async def _fake_get_account_ok(_self: BinanceExecClient) -> dict[str, Any]:
    return {"canWithdraw": False}


async def _fake_get_account_fails(_self: BinanceExecClient) -> dict[str, Any]:
    raise RuntimeError("invalid api key")


async def _fake_get_income_history(_self: BinanceExecClient, **_kwargs: Any) -> list[dict[str, Any]]:
    return FIXTURE_INCOME_ROWS


async def _fake_get_income_history_fails(
    _self: BinanceExecClient, **_kwargs: Any
) -> list[dict[str, Any]]:
    raise BinanceReviewUpstreamError("upstream error")


async def _fake_get_user_trades(
    _self: BinanceExecClient, symbol: str, **_kwargs: Any
) -> list[dict[str, Any]]:
    return BTC_USER_TRADES if symbol == "BTCUSDT" else ETH_USER_TRADES


async def _fake_get_all_orders(
    _self: BinanceExecClient, symbol: str, **_kwargs: Any
) -> list[dict[str, Any]]:
    return BTC_ORDERS if symbol == "BTCUSDT" else ETH_ORDERS


@pytest.fixture
async def binance_review_client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)
    monkeypatch.setattr(BinanceExecClient, "get_account", _fake_get_account_ok)
    monkeypatch.setattr(BinanceExecClient, "get_income_history", _fake_get_income_history)
    monkeypatch.setattr(BinanceExecClient, "get_user_trades", _fake_get_user_trades)
    monkeypatch.setattr(BinanceExecClient, "get_all_orders", _fake_get_all_orders)

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    tables = [
        BinanceReviewKey.metadata.tables["binance_review_keys"],
        BinanceReviewKey.metadata.tables["binance_trades"],
        BinanceReviewKey.metadata.tables["binance_review_sync_logs"],
    ]
    async with engine.begin() as conn:
        await conn.run_sync(BinanceReviewKey.metadata.create_all, tables=tables)
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


async def test_requires_auth(binance_review_client: AsyncClient) -> None:
    resp = await binance_review_client.get("/api/v1/binance-review/api-key")
    assert resp.status_code == 401


async def test_create_api_key_masks_secret(binance_review_client: AsyncClient) -> None:
    resp = await binance_review_client.post(
        "/api/v1/binance-review/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    assert resp.status_code == 201
    data = resp.json()["data"]
    assert data["api_key"] == "****1234"
    assert data["status"] == "active"
    assert "shh-do-not-leak-this-secret" not in resp.text
    assert "encrypted_secret" not in resp.text


async def test_save_api_key_rejects_invalid_credentials(
    binance_review_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(BinanceExecClient, "get_account", _fake_get_account_fails)
    resp = await binance_review_client.post(
        "/api/v1/binance-review/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BINANCE_REVIEW_CREDENTIALS_INVALID"


async def test_api_key_cross_user_isolation(binance_review_client: AsyncClient) -> None:
    await binance_review_client.post(
        "/api/v1/binance-review/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    resp = await binance_review_client.get(
        "/api/v1/binance-review/api-key", headers=headers_for(USER_B)
    )
    assert resp.status_code == 404


async def test_delete_api_key_then_404(binance_review_client: AsyncClient) -> None:
    await binance_review_client.post(
        "/api/v1/binance-review/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    resp = await binance_review_client.delete(
        "/api/v1/binance-review/api-key", headers=headers_for(USER_A)
    )
    assert resp.status_code == 204
    resp = await binance_review_client.get(
        "/api/v1/binance-review/api-key", headers=headers_for(USER_A)
    )
    assert resp.status_code == 404


async def test_sync_without_api_key_404(binance_review_client: AsyncClient) -> None:
    resp = await binance_review_client.post(
        "/api/v1/binance-review/sync", headers=headers_for(USER_A)
    )
    assert resp.status_code == 404


async def test_sync_upserts_idempotently_and_enriches(binance_review_client: AsyncClient) -> None:
    await binance_review_client.post(
        "/api/v1/binance-review/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )

    resp = await binance_review_client.post(
        "/api/v1/binance-review/sync", headers=headers_for(USER_A)
    )
    assert resp.status_code == 200
    log = resp.json()["data"]
    assert log["status"] == "success"
    assert log["trades_imported"] > 0

    trades_resp = await binance_review_client.get(
        "/api/v1/binance-review/trades", headers=headers_for(USER_A)
    )
    body = trades_resp.json()
    assert body["meta"]["total"] == 2  # 2 unique tradeIds, upserted idempotently

    by_symbol = {t["symbol"]: t for t in body["data"]}
    btc = by_symbol["BTCUSDT"]
    assert btc["side"] == "LONG"  # closing fill side "SELL" -> position was LONG
    assert btc["exit_price"] == 51000.0
    assert btc["quantity"] == 0.1
    assert btc["entry_price"] == 50000.0  # reconstructed from the opening fill
    assert btc["close_trigger"] == "sl_hit"  # closing order was STOP_MARKET
    assert btc["stop_loss"] == 50900.0

    eth = by_symbol["ETHUSDT"]
    assert eth["side"] == "SHORT"  # closing fill side "BUY" -> position was SHORT
    assert eth["close_trigger"] == "manual_market"

    sync_log_resp = await binance_review_client.get(
        f"/api/v1/binance-review/sync/{log['id']}", headers=headers_for(USER_A)
    )
    assert sync_log_resp.status_code == 200
    assert sync_log_resp.json()["data"]["status"] == "success"

    # Re-sync: same canned rows come back again -> upsert, not duplicate insert.
    resp2 = await binance_review_client.post(
        "/api/v1/binance-review/sync", headers=headers_for(USER_A)
    )
    assert resp2.status_code == 200
    assert resp2.json()["data"]["status"] == "success"

    trades_resp_2 = await binance_review_client.get(
        "/api/v1/binance-review/trades", headers=headers_for(USER_A)
    )
    assert trades_resp_2.json()["meta"]["total"] == 2  # still 2, not 4


async def test_sync_trades_cross_user_isolation(binance_review_client: AsyncClient) -> None:
    await binance_review_client.post(
        "/api/v1/binance-review/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    await binance_review_client.post("/api/v1/binance-review/sync", headers=headers_for(USER_A))

    resp = await binance_review_client.get(
        "/api/v1/binance-review/trades", headers=headers_for(USER_B)
    )
    assert resp.json()["meta"]["total"] == 0


async def test_sync_log_cross_user_forbidden(binance_review_client: AsyncClient) -> None:
    await binance_review_client.post(
        "/api/v1/binance-review/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    resp = await binance_review_client.post("/api/v1/binance-review/sync", headers=headers_for(USER_A))
    log_id = resp.json()["data"]["id"]

    resp = await binance_review_client.get(
        f"/api/v1/binance-review/sync/{log_id}", headers=headers_for(USER_B)
    )
    assert resp.status_code == 403


async def test_sync_failure_marks_log_failed(
    binance_review_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await binance_review_client.post(
        "/api/v1/binance-review/api-key", json=NEW_KEY, headers=headers_for(USER_A)
    )
    monkeypatch.setattr(BinanceExecClient, "get_income_history", _fake_get_income_history_fails)

    resp = await binance_review_client.post("/api/v1/binance-review/sync", headers=headers_for(USER_A))
    assert resp.status_code == 502

    factory = app.state._test_session_factory
    async with factory() as session:
        result = await session.execute(
            select(BinanceReviewSyncLog).where(BinanceReviewSyncLog.user_id == USER_A)
        )
        logs = list(result.scalars().all())
        assert len(logs) == 1
        assert logs[0].status == "failed"
        assert logs[0].error is not None
