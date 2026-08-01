"""Sprint 1 "satu mulut" delivery tests (docs/IMPLEMENTATION-PLAN.md §3):
sender retry, delivery-pass ordering + quiet hours, ingest endpoint auth.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import get_db
from app.delivery import sender as sender_module
from app.delivery.service import _in_quiet_hours, run_delivery_pass
from app.execution.alert_models import Alert as AlertModel
from app.main import app

INTERNAL_KEY = "test-internal-key"
USER_A = "00000000-0000-0000-0000-00000000000a"


def headers_for(user_id: str) -> dict[str, str]:
    return {"x-internal-key": INTERNAL_KEY, "x-internal-user-id": user_id}


# --- sender retry ------------------------------------------------------


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient. `post_impl` decides success/failure
    per call so tests can script attempt sequences."""

    calls = 0
    post_impl: Any = staticmethod(lambda _n: _FakeResponse({"ok": True}))

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        return None

    async def post(self, *_args: Any, **_kwargs: Any) -> _FakeResponse:
        type(self).calls += 1
        return type(self).post_impl(type(self).calls)


async def _noop_sleep(_seconds: float) -> None:
    return None


@pytest.fixture(autouse=True)
def _platform_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "PLATFORM_BOT_TOKEN", "fake-token")
    monkeypatch.setattr(settings, "PLATFORM_CHAT_ID", "fake-chat")
    monkeypatch.setattr(sender_module.asyncio, "sleep", _noop_sleep)


async def test_send_telegram_succeeds_first_try(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeAsyncClient.calls = 0
    _FakeAsyncClient.post_impl = staticmethod(lambda _n: _FakeResponse({"ok": True}))
    monkeypatch.setattr(sender_module.httpx, "AsyncClient", _FakeAsyncClient)

    ok = await sender_module.send_telegram("hello", chat_id="fake-chat")

    assert ok is True
    assert _FakeAsyncClient.calls == 1


async def test_send_telegram_retries_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeAsyncClient.calls = 0

    def _impl(n: int) -> _FakeResponse:
        if n < 3:
            raise httpx.ConnectError("boom")
        return _FakeResponse({"ok": True})

    _FakeAsyncClient.post_impl = staticmethod(_impl)
    monkeypatch.setattr(sender_module.httpx, "AsyncClient", _FakeAsyncClient)

    ok = await sender_module.send_telegram("hello", chat_id="fake-chat")

    assert ok is True
    assert _FakeAsyncClient.calls == 3


async def test_send_telegram_fails_after_max_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeAsyncClient.calls = 0

    def _impl(_n: int) -> _FakeResponse:
        raise httpx.ConnectError("boom")

    _FakeAsyncClient.post_impl = staticmethod(_impl)
    monkeypatch.setattr(sender_module.httpx, "AsyncClient", _FakeAsyncClient)

    ok = await sender_module.send_telegram("hello", chat_id="fake-chat")

    assert ok is False
    assert _FakeAsyncClient.calls == 3


async def test_send_telegram_skips_without_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "PLATFORM_BOT_TOKEN", "")
    ok = await sender_module.send_telegram("hello", chat_id="fake-chat")
    assert ok is False


# --- quiet hours ---------------------------------------------------------

WIB = ZoneInfo("Asia/Jakarta")


def test_quiet_hours_holds_overnight() -> None:
    assert _in_quiet_hours(datetime(2026, 8, 1, 23, 0, tzinfo=WIB)) is True
    assert _in_quiet_hours(datetime(2026, 8, 2, 3, 0, tzinfo=WIB)) is True


def test_quiet_hours_open_during_day() -> None:
    assert _in_quiet_hours(datetime(2026, 8, 1, 12, 0, tzinfo=WIB)) is False
    assert _in_quiet_hours(datetime(2026, 8, 1, 6, 0, tzinfo=WIB)) is False
    assert _in_quiet_hours(datetime(2026, 8, 1, 22, 0, tzinfo=WIB)) is True


# --- delivery pass: ordering + quiet hours + failure counting ------------


@pytest.fixture
async def db_session() -> AsyncIterator[Any]:
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    async with engine.begin() as conn:
        await conn.run_sync(AlertModel.metadata.create_all, tables=[AlertModel.__table__])
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _make_alert(**overrides: Any) -> AlertModel:
    dedupe_key = overrides.pop("dedupe_key")
    defaults: dict[str, Any] = {
        "user_id": USER_A,
        "type": "opportunity",
        "token_symbol": "BTCUSDT",
        "title": dedupe_key,
        "body": "b",
        "severity": "info",
        "delivery_state": "pending",
        "delivery_attempts": 0,
        "source": "market_pulse",
    }
    defaults.update(overrides)
    return AlertModel(dedupe_key=dedupe_key, **defaults)


async def test_delivery_pass_noop_when_disabled(
    db_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "DELIVERY_ENABLED", False)
    db_session.add(_make_alert(dedupe_key="noop-1"))
    await db_session.commit()

    sent = await run_delivery_pass(db_session)

    assert sent == 0


async def test_delivery_pass_orders_by_severity_then_created_at(
    db_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "DELIVERY_ENABLED", True)
    now = datetime.now(UTC)
    # Insertion order deliberately scrambled vs. expected send order.
    db_session.add_all(
        [
            _make_alert(dedupe_key="d-info", severity="info", created_at=now),
            _make_alert(dedupe_key="d-critical", severity="critical", created_at=now),
            _make_alert(dedupe_key="d-warning", severity="warning", created_at=now),
        ]
    )
    await db_session.commit()

    sent_order: list[str] = []

    async def _fake_send(
        text: str, *, chat_id: str, reply_markup: Any = None  # noqa: ARG001
    ) -> bool:
        sent_order.append(text.split("\n", 1)[0].replace("<b>", "").replace("</b>", ""))
        return True

    monkeypatch.setattr("app.delivery.service.send_telegram", _fake_send)

    sent = await run_delivery_pass(db_session)

    assert sent == 3
    assert sent_order == ["d-critical", "d-warning", "d-info"]


async def test_delivery_pass_holds_info_during_quiet_hours(
    db_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "DELIVERY_ENABLED", True)
    monkeypatch.setattr("app.delivery.service._in_quiet_hours", lambda _now: True)
    now = datetime.now(UTC)
    db_session.add_all(
        [
            _make_alert(dedupe_key="q-info", severity="info", created_at=now),
            _make_alert(dedupe_key="q-critical", severity="critical", created_at=now),
        ]
    )
    await db_session.commit()

    async def _fake_send(_text: str, *, chat_id: str, reply_markup: Any = None) -> bool:  # noqa: ARG001
        return True

    monkeypatch.setattr("app.delivery.service.send_telegram", _fake_send)

    sent = await run_delivery_pass(db_session)

    assert sent == 1
    rows = {
        row["dedupe_key"]: row["delivery_state"]
        for row in (await db_session.execute(AlertModel.__table__.select())).mappings().all()
    }
    assert rows["q-critical"] == "sent"
    assert rows["q-info"] == "pending"


async def test_delivery_pass_ignores_stale_alerts(
    db_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "DELIVERY_ENABLED", True)
    stale = datetime.now(UTC) - timedelta(hours=3)
    db_session.add(_make_alert(dedupe_key="stale-1", severity="critical", created_at=stale))
    await db_session.commit()

    async def _fake_send(_text: str, *, chat_id: str, reply_markup: Any = None) -> bool:  # noqa: ARG001
        return True

    monkeypatch.setattr("app.delivery.service.send_telegram", _fake_send)

    sent = await run_delivery_pass(db_session)

    assert sent == 0


async def test_delivery_pass_marks_failed_after_max_attempts(
    db_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "DELIVERY_ENABLED", True)
    db_session.add(_make_alert(dedupe_key="f-1", severity="critical", delivery_attempts=2))
    await db_session.commit()

    async def _fake_send(_text: str, *, chat_id: str, reply_markup: Any = None) -> bool:  # noqa: ARG001
        return False

    monkeypatch.setattr("app.delivery.service.send_telegram", _fake_send)

    await run_delivery_pass(db_session)

    row = (
        (
            await db_session.execute(
                AlertModel.__table__.select().where(AlertModel.dedupe_key == "f-1")
            )
        )
        .mappings()
        .one()
    )
    assert row["delivery_attempts"] == 3
    assert row["delivery_state"] == "failed"


# --- ingest router ---------------------------------------------------------


@pytest.fixture
async def ingest_client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(settings, "INTERNAL_API_KEY", INTERNAL_KEY)

    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    async with engine.begin() as conn:
        await conn.run_sync(AlertModel.metadata.create_all, tables=[AlertModel.__table__])
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncIterator[Any]:
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


INGEST_BODY = {
    "type": "daily_digest",
    "token_symbol": "BTCUSDT",
    "title": "Daily Bias BTC",
    "body": "Regime bullish.",
    "severity": "info",
    "dedupe_key": "digest-2026-08-01",
    "source": "quant",
}


async def test_ingest_requires_auth(ingest_client: AsyncClient) -> None:
    resp = await ingest_client.post("/api/v1/alerts/ingest", json=INGEST_BODY)
    assert resp.status_code == 401


async def test_ingest_creates_alert_with_internal_key(ingest_client: AsyncClient) -> None:
    resp = await ingest_client.post(
        "/api/v1/alerts/ingest", json=INGEST_BODY, headers=headers_for(USER_A)
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["inserted"] is True

    factory = app.state._test_session_factory
    async with factory() as session:
        row = (
            (
                await session.execute(
                    AlertModel.__table__.select().where(
                        AlertModel.dedupe_key == INGEST_BODY["dedupe_key"]
                    )
                )
            )
            .mappings()
            .one()
        )
    assert row["delivery_state"] == "pending"
    assert row["source"] == "quant"
    assert row["user_id"] == USER_A


async def test_ingest_honors_shadow_delivery_state(ingest_client: AsyncClient) -> None:
    body = {**INGEST_BODY, "dedupe_key": "digest-shadow-1", "delivery_state": "suppressed"}
    resp = await ingest_client.post(
        "/api/v1/alerts/ingest", json=body, headers=headers_for(USER_A)
    )
    assert resp.status_code == 200

    factory = app.state._test_session_factory
    async with factory() as session:
        row = (
            (
                await session.execute(
                    AlertModel.__table__.select().where(
                        AlertModel.dedupe_key == "digest-shadow-1"
                    )
                )
            )
            .mappings()
            .one()
        )
    assert row["delivery_state"] == "suppressed"
