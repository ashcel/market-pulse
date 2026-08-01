"""Safe API-level Sprint 3 flow: facts -> Ideas -> Ticket decisions.

Permit/execute are deliberately exercised only at validation/not-found paths;
no order client can be reached by this test.
"""

from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool

from app.auth.models import User
from app.config import settings
from app.database import get_db
from app.execution.decision_snapshot import DecisionSnapshot
from app.execution.models import TradePermit
from app.forward_test.models import EvalLog
from app.main import app
from app.signals.models import SignalEvent

KEY = "sprint3-internal-key"
USER_ID = "00000000-0000-0000-0000-00000000000b"


@compiles(JSONB, "sqlite")
def _compile_jsonb_on_sqlite(type_: Any, compiler: Any, **kw: Any) -> str:  # noqa: ARG001
    return "JSON"


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", KEY)
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    tables = [User.__table__, SignalEvent.__table__, DecisionSnapshot.__table__, TradePermit.__table__, EvalLog.__table__]
    async with engine.begin() as conn:
        await conn.run_sync(User.metadata.create_all, tables=tables)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        db.add(User(id=USER_ID, email="flow@example.test", display_name="Flow"))
        await db.commit()

    async def override_get_db() -> AsyncIterator[Any]:
        async with factory() as db:
            yield db

    app.dependency_overrides[get_db] = override_get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


def headers() -> dict[str, str]:
    return {"x-internal-key": KEY, "x-internal-user-id": USER_ID}


async def test_sprint3_safe_api_flow(client: AsyncClient) -> None:
    signal = {
        "source": "quant", "source_version": "test", "symbol": "BTCUSDT", "side": "long",
        "horizon": "swing", "kind": "ma-alignment", "conviction": "high",
        "detected_at": "2026-08-01T00:00:00Z", "features": {},
        "dedup_key": "quant|BTCUSDT|long|swing|2026-08-01|ma-alignment",
    }
    assert (await client.post("/api/v1/ingest/signal", headers=headers(), json=signal)).status_code == 200
    ideas = await client.get("/api/v1/opportunities", headers=headers())
    assert ideas.status_code == 200
    assert ideas.json()["data"][0]["symbol"] == "BTCUSDT"

    # Both execution endpoints validate safely before any exchange order path.
    assert (await client.post("/api/v1/execution/permits/", headers=headers(), json={})).status_code == 422
    assert (await client.post("/api/v1/execution/permits/missing/execute", headers=headers(), json={})).status_code == 404

    entry = await client.post("/api/v1/decisions", headers=headers(), json={
        "symbol": "BTCUSDT", "objective": "swing", "direction": "long",
        "verdict_at_time": "ticket_entry", "engine_version": "test",
    })
    assert entry.status_code == 201
    assert (await client.patch(f"/api/v1/decisions/{entry.json()['data']['id']}/action", headers=headers(), json={"user_action": "took_trade"})).status_code == 200

    skipped = await client.post("/api/v1/decisions", headers=headers(), json={
        "symbol": "BTCUSDT", "objective": "swing", "direction": "long",
        "verdict_at_time": "ticket_skip", "engine_version": "test",
    })
    captured = await client.patch(f"/api/v1/decisions/{skipped.json()['data']['id']}/action", headers=headers(), json={"user_action": "rejected_skip", "skip_reason": "late"})
    assert captured.status_code == 200
    assert captured.json()["data"]["skip_reason"] == "late"
