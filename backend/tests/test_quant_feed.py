"""The partial proxy flip (docs/IMPLEMENTATION-PLAN.md §3 Sprint 2 task 5).

`FEED_FROM_DB=False` (the shipped default) must be byte-identical to the old
pure proxy — that is the one-line rollback. `True` swaps only the `signals`
feed for our own `signal_events`; regime, flow, news and the forecast keep
coming from upstream, because the forecast engine is not ported until
Sprint 5.
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
from app.quant import router as quant_router
from app.signals.models import SignalEvent

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"

UPSTREAM_BODY = {
    "generatedAt": "2026-08-01T00:00:00.000Z",
    "summary": {"days": 14, "total": 99, "notified": 99, "silent": 0, "cryptoRegime": "bear"},
    "regimes": {"crypto": {"regime": "bear"}},
    "moneyFlow": {"inflow": 1},
    "news": [{"title": "upstream news"}],
    "signals": [{"symbol": "UPSTREAMUSDT", "kind": "proxied", "notified": True}],
}


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)

    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    async with engine.begin() as conn:
        await conn.run_sync(SignalEvent.metadata.create_all, tables=[SignalEvent.__table__])
    factory = async_sessionmaker(engine, expire_on_commit=False)

    now = datetime.now(UTC)
    async with factory() as session:
        session.add_all(
            [
                SignalEvent(
                    id="s1",
                    source="quant",
                    source_version="abc1234",
                    symbol="BTCUSDT",
                    side="long",
                    horizon="swing",
                    kind="ma-alignment",
                    conviction="very_high",
                    detected_at=now - timedelta(hours=1),
                    features={
                        "at": "2026-08-01T09:00:00.000Z",
                        "symbol": "BTCUSDT",
                        "kind": "ma-alignment",
                        "direction": "long",
                        # Hyphenated on purpose: the source's own spelling must
                        # survive the round trip, not the normalised column.
                        "conviction": "very-high",
                        "notified": True,
                        "rank": 8,
                    },
                    dedup_key="d1",
                ),
                SignalEvent(
                    id="s2",
                    source="quant",
                    source_version="abc1234",
                    symbol="ONDOUSDT",
                    side="short",
                    horizon="swing",
                    kind="near-52w-high",
                    conviction="medium",
                    detected_at=now - timedelta(hours=2),
                    features={"notified": False},
                    dedup_key="d2",
                ),
            ]
        )
        await session.commit()

    async def override_get_db() -> AsyncIterator[Any]:
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


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


def _stub_upstream(monkeypatch: pytest.MonkeyPatch, status: int = 200) -> list[str]:
    calls: list[str] = []

    async def _fake_fetch(path: str, params: Any, init_data: Any) -> tuple[int, Any]:  # noqa: ARG001
        calls.append(path)
        return status, UPSTREAM_BODY if status == 200 else {"error": "upstream down"}

    monkeypatch.setattr(quant_router, "_fetch", _fake_fetch)
    return calls


def test_flip_is_off_by_default() -> None:
    assert quant_router.FEED_FROM_DB is False


async def test_state_is_pure_proxy_when_flag_off(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(quant_router, "FEED_FROM_DB", False)
    calls = _stub_upstream(monkeypatch)

    resp = await client.get("/api/v1/quant/state", headers=headers_for(USER_A))

    assert resp.status_code == 200
    assert resp.json() == UPSTREAM_BODY  # untouched, including the feed
    assert calls == ["/api/state"]


async def test_state_serves_feed_from_db_when_flag_on(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(quant_router, "FEED_FROM_DB", True)
    _stub_upstream(monkeypatch)

    resp = await client.get("/api/v1/quant/state", headers=headers_for(USER_A))
    body = resp.json()

    assert resp.status_code == 200
    # Feed: ours now, newest first, byte-faithful to what the detector wrote.
    assert [row["symbol"] for row in body["signals"]] == ["BTCUSDT", "ONDOUSDT"]
    assert body["signals"][0]["conviction"] == "very-high"
    assert body["signalsSource"] == "market_pulse"
    assert body["summary"]["total"] == 2
    assert body["summary"]["notified"] == 1
    assert body["summary"]["silent"] == 1
    # Everything else still comes from upstream — the flip is partial by design.
    assert body["regimes"] == UPSTREAM_BODY["regimes"]
    assert body["moneyFlow"] == UPSTREAM_BODY["moneyFlow"]
    assert body["news"] == UPSTREAM_BODY["news"]
    assert body["summary"]["cryptoRegime"] == "bear"


async def test_upstream_failure_passes_through_even_with_flag_on(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regime/flow/news still come from upstream, so an upstream failure is a
    failure — quietly returning a DB-only body would hide the outage behind a
    200 with half the payload missing."""
    monkeypatch.setattr(quant_router, "FEED_FROM_DB", True)
    _stub_upstream(monkeypatch, status=502)

    resp = await client.get("/api/v1/quant/state", headers=headers_for(USER_A))

    assert resp.status_code == 502
