"""Trade-review persistence round-trip tests against an ephemeral SQLite
database. `POST /review/{trade_id}` just persists a client-supplied JSON
verbatim — no LLM call happens on the backend.
"""

from collections.abc import AsyncIterator
from datetime import datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.binance_review.models import BinanceReviewKey, BinanceTrade
from app.config import settings
from app.database import get_db
from app.main import app

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"
USER_B = "00000000-0000-0000-0000-00000000000b"


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


@pytest.fixture
async def review_client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    tables = [
        BinanceReviewKey.metadata.tables["binance_review_keys"],
        BinanceReviewKey.metadata.tables["binance_trades"],
        BinanceReviewKey.metadata.tables["trade_reviews"],
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


async def _seed_trade(user_id: str, trade_id: str = "trade-1") -> None:
    factory = app.state._test_session_factory
    now = datetime.now()
    async with factory() as session:
        session.add(
            BinanceTrade(
                id=trade_id,
                user_id=user_id,
                exchange_trade_id=f"binance-futures-{trade_id}",
                symbol="BTCUSDT",
                side="LONG",
                leverage=10.0,
                entry_price=50_000.0,
                exit_price=51_000.0,
                quantity=0.1,
                realized_pnl=100.0,
                roi_percent=2.0,
                fees=1.0,
                opened_at=now - timedelta(minutes=30),
                open_time_source="order_history",
                closed_at=now,
            )
        )
        await session.commit()


REVIEW_PAYLOAD = {
    "review_mode": "strict",
    "severity_score": 42,
    "severity_tier": "MODERATE",
    "grade": "B+",
    "one_liner": "Solid entry, exited a bit early.",
    "full_review": {
        "summary": "Detailed AI-generated review text goes here.",
        "sections": [{"title": "Entry", "body": "Good confluence."}],
        "score_breakdown": {"setup": 8, "execution": 7, "discipline": 9},
    },
    "model_used": "claude-opus-4-8",
}


async def test_requires_auth(review_client: AsyncClient) -> None:
    resp = await review_client.get("/api/v1/review/trade-1")
    assert resp.status_code == 401


async def test_post_persists_review_verbatim(review_client: AsyncClient) -> None:
    await _seed_trade(USER_A)
    resp = await review_client.post(
        "/api/v1/review/trade-1", json=REVIEW_PAYLOAD, headers=headers_for(USER_A)
    )
    assert resp.status_code == 201
    data = resp.json()["data"]
    assert data["binance_trade_id"] == "trade-1"
    assert data["version"] == 1
    assert data["full_review"] == REVIEW_PAYLOAD["full_review"]
    assert data["grade"] == "B+"
    assert data["model_used"] == "claude-opus-4-8"


async def test_get_returns_latest_version(review_client: AsyncClient) -> None:
    await _seed_trade(USER_A)
    await review_client.post(
        "/api/v1/review/trade-1", json=REVIEW_PAYLOAD, headers=headers_for(USER_A)
    )
    updated_payload = {**REVIEW_PAYLOAD, "one_liner": "Revised take.", "grade": "A-"}
    resp = await review_client.post(
        "/api/v1/review/trade-1", json=updated_payload, headers=headers_for(USER_A)
    )
    assert resp.status_code == 201
    assert resp.json()["data"]["version"] == 2

    resp = await review_client.get("/api/v1/review/trade-1", headers=headers_for(USER_A))
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["version"] == 2
    assert data["one_liner"] == "Revised take."
    assert data["grade"] == "A-"


async def test_get_unknown_trade_404(review_client: AsyncClient) -> None:
    resp = await review_client.get("/api/v1/review/does-not-exist", headers=headers_for(USER_A))
    assert resp.status_code == 404


async def test_get_review_when_trade_exists_but_no_review_404(review_client: AsyncClient) -> None:
    await _seed_trade(USER_A)
    resp = await review_client.get("/api/v1/review/trade-1", headers=headers_for(USER_A))
    assert resp.status_code == 404


async def test_post_review_cross_user_forbidden(review_client: AsyncClient) -> None:
    await _seed_trade(USER_A)
    resp = await review_client.post(
        "/api/v1/review/trade-1", json=REVIEW_PAYLOAD, headers=headers_for(USER_B)
    )
    assert resp.status_code == 403


async def test_get_review_cross_user_forbidden(review_client: AsyncClient) -> None:
    await _seed_trade(USER_A)
    await review_client.post(
        "/api/v1/review/trade-1", json=REVIEW_PAYLOAD, headers=headers_for(USER_A)
    )
    resp = await review_client.get("/api/v1/review/trade-1", headers=headers_for(USER_B))
    assert resp.status_code == 403
