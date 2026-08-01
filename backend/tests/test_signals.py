"""Sprint 2 "balik arah" signal-facts tests (docs/IMPLEMENTATION-PLAN.md §2.1,
§3): ingest auth, idempotency through dedup_key, and the read query.

The DB-level append-only trigger is Postgres-specific and is verified against a
scratch Postgres in the sprint's verification run, not here — sqlite has no
plpgsql. What IS covered here is that the repo exposes no mutation path at all.
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
from app.main import app
from app.signals import repo
from app.signals.models import SignalEvent

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


@pytest.fixture
async def session_factory() -> AsyncIterator[Any]:
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    async with engine.begin() as conn:
        await conn.run_sync(SignalEvent.metadata.create_all, tables=[SignalEvent.__table__])
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
async def db_session(session_factory: Any) -> AsyncIterator[Any]:
    async with session_factory() as session:
        yield session


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


BODY = {
    "source": "quant",
    "source_version": "abc1234",
    "symbol": "BTCUSDT",
    "side": "long",
    "horizon": "swing",
    "kind": "ma-alignment",
    "conviction": "high",
    "detected_at": "2026-08-01T00:00:19.858Z",
    "features": {"notified": True, "rank": 8, "regime": "bear"},
    "dedup_key": "quant|BTCUSDT|long|swing|2026-08-01|ma-alignment",
}


# --- ingest endpoint -----------------------------------------------------


async def test_ingest_requires_internal_key(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/ingest/signal", json=BODY)
    assert resp.status_code == 401


async def test_ingest_rejects_wrong_internal_key(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/ingest/signal",
        json=BODY,
        headers={"x-internal-key": "wrong", "x-internal-user-id": USER_A},
    )
    assert resp.status_code == 401


async def test_ingest_inserts_then_dedupes(client: AsyncClient, session_factory: Any) -> None:
    first = await client.post("/api/v1/ingest/signal", json=BODY, headers=headers_for(USER_A))
    assert first.status_code == 200
    assert first.json()["data"]["inserted"] is True

    # Same dedup_key — a retry, a re-scan, or the same setup detected twice in
    # a day. All three are the same fact.
    second = await client.post("/api/v1/ingest/signal", json=BODY, headers=headers_for(USER_A))
    assert second.status_code == 200
    assert second.json()["data"]["inserted"] is False

    async with session_factory() as session:
        rows = list(
            (await session.execute(SignalEvent.__table__.select())).mappings()
        )
    assert len(rows) == 1
    assert rows[0]["source"] == "quant"
    assert rows[0]["source_version"] == "abc1234"
    assert rows[0]["features"] == BODY["features"]


async def test_ingest_stores_features_verbatim(client: AsyncClient, session_factory: Any) -> None:
    body = {
        **BODY,
        "dedup_key": "quant|ETHUSDT|short|swing|2026-08-01|bos-bearish",
        "symbol": "ethusdt",
        "side": "short",
        "kind": "bos-bearish",
        "features": {"stats": {"n": 948, "winRate": 32.5}, "provisional": False},
    }
    resp = await client.post("/api/v1/ingest/signal", json=body, headers=headers_for(USER_A))
    assert resp.status_code == 200

    async with session_factory() as session:
        row = (
            (
                await session.execute(
                    SignalEvent.__table__.select().where(
                        SignalEvent.dedup_key == body["dedup_key"]
                    )
                )
            )
            .mappings()
            .one()
        )
    assert row["symbol"] == "ETHUSDT"  # normalised on write
    assert row["features"] == body["features"]  # untouched


# --- repo ----------------------------------------------------------------


async def _insert(db: Any, **overrides: Any) -> bool:
    defaults: dict[str, Any] = {
        "id": overrides.pop("id", None) or f"id-{overrides.get('dedup_key', 'x')}",
        "source": "quant",
        "source_version": "abc1234",
        "symbol": "BTCUSDT",
        "side": "long",
        "horizon": "swing",
        "kind": "ma-alignment",
        "conviction": "high",
        "detected_at": datetime.now(UTC),
        "expires_at": None,
        "features": {},
        "dedup_key": "k-1",
    }
    defaults.update(overrides)
    return await repo.insert_signal(db, **defaults)


async def test_insert_signal_returns_false_on_duplicate(db_session: Any) -> None:
    assert await _insert(db_session, dedup_key="dup-1") is True
    assert await _insert(db_session, id="other", dedup_key="dup-1") is False


async def test_list_signals_filters_and_orders(db_session: Any) -> None:
    now = datetime.now(UTC)
    await _insert(db_session, dedup_key="a", symbol="BTCUSDT", detected_at=now - timedelta(hours=1))
    await _insert(db_session, dedup_key="b", symbol="ETHUSDT", detected_at=now)
    await _insert(
        db_session, dedup_key="c", symbol="BTCUSDT", detected_at=now - timedelta(days=9)
    )
    await _insert(db_session, dedup_key="d", symbol="SOLUSDT", source="smc", detected_at=now)

    recent = await repo.list_signals(db_session, since=now - timedelta(days=2))
    assert [row.dedup_key for row in recent] == ["b", "d", "a"]  # newest first, old one dropped

    only_btc = await repo.list_signals(db_session, since=now - timedelta(days=2), symbol="btcusdt")
    assert [row.dedup_key for row in only_btc] == ["a"]

    only_quant = await repo.list_signals(
        db_session, since=now - timedelta(days=2), sources=["quant"]
    )
    assert [row.dedup_key for row in only_quant] == ["b", "a"]

    scalps = await repo.list_signals(
        db_session, since=now - timedelta(days=2), horizon="scalp"
    )
    assert scalps == []


def test_repo_exposes_no_mutation_path() -> None:
    """Append-only is a property of the module surface too, not only of the
    trigger — nothing here may update or delete."""
    exported = {name for name in dir(repo) if not name.startswith("_")}
    assert "insert_signal" in exported
    assert "list_signals" in exported
    assert not {name for name in exported if "update" in name or "delete" in name}
