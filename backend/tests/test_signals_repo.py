"""`signal_events` repo — idempotent insert against an ephemeral SQLite DB.

Mirrors the pattern in test_trades.py: only the DB engine is substituted, so
the real repo/model path (including `ON CONFLICT (dedup_key) DO NOTHING`)
runs for real.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.signals.models import SignalEvent
from app.signals.repo import insert_signal, list_signals


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    table = SignalEvent.metadata.tables["signal_events"]
    async with engine.begin() as conn:
        await conn.run_sync(SignalEvent.metadata.create_all, tables=[table])
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            yield session
    finally:
        await engine.dispose()


def _values(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = dict(
        id="11111111-1111-1111-1111-111111111111",
        source="reaccumulation",
        source_version="1.0.0",
        symbol="BTCUSDT",
        side="long",
        horizon="swing",
        kind="reaccumulation",
        conviction="high",
        detected_at=datetime(2026, 8, 1, tzinfo=UTC),
        expires_at=None,
        features={"score": 78.0},
        dedup_key="reaccumulation|BTCUSDT|long|swing|2026-08-01|reaccumulation",
        status="shadow",
        context_ref=None,
    )
    base.update(overrides)
    return base


async def test_insert_signal_returns_true_on_first_write(db: AsyncSession) -> None:
    inserted = await insert_signal(db, **_values())
    assert inserted is True

    rows = await list_signals(db, source="reaccumulation")
    assert len(rows) == 1
    assert rows[0].dedup_key == "reaccumulation|BTCUSDT|long|swing|2026-08-01|reaccumulation"
    assert rows[0].status == "shadow"


async def test_insert_signal_is_a_no_op_on_duplicate_dedup_key(db: AsyncSession) -> None:
    first = await insert_signal(db, **_values())
    assert first is True

    # Same dedup_key, different id/features — the retry/duplicate case.
    second = await insert_signal(
        db, **_values(id="22222222-2222-2222-2222-222222222222", features={"score": 91.0})
    )
    assert second is False

    rows = await list_signals(db, source="reaccumulation")
    assert len(rows) == 1
    assert rows[0].id == "11111111-1111-1111-1111-111111111111"
    assert rows[0].features == {"score": 78.0}


async def test_list_signals_filters_by_symbol(db: AsyncSession) -> None:
    await insert_signal(db, **_values())
    await insert_signal(
        db,
        **_values(
            id="33333333-3333-3333-3333-333333333333",
            symbol="ETHUSDT",
            dedup_key="reaccumulation|ETHUSDT|long|swing|2026-08-01|reaccumulation",
        ),
    )

    rows = await list_signals(db, source="reaccumulation", symbol="ethusdt")
    assert len(rows) == 1
    assert rows[0].symbol == "ETHUSDT"
