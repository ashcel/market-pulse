"""Sprint 3: a Ticket skip persists its structured reason through the API."""

from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.auth.models import User
from app.config import settings
from app.database import get_db
from app.execution.decision_snapshot import DecisionSnapshot
from app.main import app

INTERNAL_KEY = "test-internal-key"
USER_ID = "00000000-0000-0000-0000-00000000000a"


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    async with engine.begin() as conn:
        await conn.run_sync(User.metadata.create_all, tables=[User.__table__, DecisionSnapshot.__table__])
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        session.add(User(id=USER_ID, email="skip@example.test", display_name="Skip"))
        await session.commit()

    async def override_get_db() -> AsyncIterator[Any]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


def headers() -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": USER_ID}


async def test_skip_reason_is_persisted_via_decision_api(client: AsyncClient) -> None:
    created = await client.post(
        "/api/v1/decisions",
        headers=headers(),
        json={
            "symbol": "BTCUSDT", "objective": "swing", "direction": "long",
            "verdict_at_time": "ticket_skip", "engine_version": "test",
        },
    )
    assert created.status_code == 201
    decision_id = created.json()["data"]["id"]

    response = await client.patch(
        f"/api/v1/decisions/{decision_id}/action",
        headers=headers(),
        json={"user_action": "rejected_skip", "skip_reason": "risk"},
    )
    assert response.status_code == 200
    assert response.json()["data"]["skip_reason"] == "risk"

    persisted = await client.get(f"/api/v1/decisions/{decision_id}", headers=headers())
    assert persisted.json()["data"]["skip_reason"] == "risk"


async def test_skip_reason_is_rejected_for_non_skip_action(client: AsyncClient) -> None:
    created = await client.post(
        "/api/v1/decisions", headers=headers(),
        json={"symbol": "BTCUSDT", "objective": "swing", "direction": "long", "verdict_at_time": "x", "engine_version": "test"},
    )
    response = await client.patch(
        f"/api/v1/decisions/{created.json()['data']['id']}/action",
        headers=headers(), json={"user_action": "took_trade", "skip_reason": "risk"},
    )
    assert response.status_code == 422
