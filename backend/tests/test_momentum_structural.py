"""Structural backing cache: slow context, recorded but never enforced.

The property that matters most here is a *negative* one — this data must not
be able to influence what the radar detects or surfaces. It rides on the view
model and the forward-test snapshot, and the aggregator never sees it.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.momentum.structural_cache import (
    SOURCE,
    STALE_SECONDS,
    StructuralBacking,
    StructuralCache,
)
from app.signals.models import SignalEvent
from app.signals.repo import insert_signal

NOW = datetime(2026, 8, 12, 12, 0, tzinfo=UTC)


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


async def write(
    db: AsyncSession,
    symbol: str,
    *,
    state: str = "ACCUMULATING",
    score: float = 72.0,
    detected_at: datetime = NOW,
) -> None:
    await insert_signal(
        db,
        id=f"{symbol}-{state}",
        source=SOURCE,
        source_version="1.0.0",
        symbol=symbol,
        side="long",
        horizon="swing",
        kind="reaccumulation",
        conviction="high",
        detected_at=detected_at,
        expires_at=detected_at + timedelta(days=3),
        features={"state": state, "score": score},
        dedup_key=f"{SOURCE}|{symbol}|long|swing|2026-08-12|reaccumulation|{state}",
    )


# ── the cache ────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_backing_is_read_from_the_reaccumulation_screen(db: AsyncSession) -> None:
    await write(db, "BTC", state="SECOND_EXPANSION", score=81.0)
    # Drive the same query the cache runs, against the ephemeral session.
    from app.signals.repo import list_signals

    rows = await list_signals(db, source=SOURCE, limit=10, latest_per_symbol=True, sort="score")
    assert [row.symbol for row in rows] == ["BTC"]
    assert rows[0].features["state"] == "SECOND_EXPANSION"


def test_a_missing_symbol_has_no_backing() -> None:
    assert StructuralCache().get("NOPE") is None


def test_backing_goes_stale() -> None:
    """A base read six hours ago is not describing today's tape."""
    backing = StructuralBacking(
        symbol="BTC",
        state="ACCUMULATING",
        score=70.0,
        side="long",
        detected_at=NOW.timestamp(),
    )
    assert backing.is_stale(NOW.timestamp() + 60) is False
    assert backing.is_stale(NOW.timestamp() + STALE_SECONDS + 1) is True


def test_a_stale_read_is_not_served() -> None:
    cache = StructuralCache()
    cache._backing["BTC"] = StructuralBacking(
        symbol="BTC",
        state="ACCUMULATING",
        score=70.0,
        side="long",
        detected_at=NOW.timestamp(),
    )
    assert cache.get("BTC", NOW.timestamp() + 60) is not None
    assert cache.get("BTC", NOW.timestamp() + STALE_SECONDS + 1) is None
    # Without a clock the caller gets whatever is cached, staleness included —
    # explicit, so a caller cannot forget by accident.
    assert cache.get("BTC") is not None


# ── the guarantee: it cannot reach detection ────────────────────────────────


def test_the_aggregator_has_no_structural_input() -> None:
    """Structural backing rides on the scanner's view model and the
    forward-test snapshot. `advance_situation` — which decides state and
    `worth_watching` — must not accept it at all, so a hunch cannot quietly
    become an unmeasured filter."""
    import inspect

    from smc.situation import advance_situation

    parameters = set(inspect.signature(advance_situation).parameters)
    assert "structural" not in parameters
    assert "structural_state" not in parameters
    assert "backing" not in parameters


def test_the_situation_carries_no_structural_field() -> None:
    from dataclasses import fields

    from smc.situation import Situation

    names = {field.name for field in fields(Situation)}
    assert "structural" not in names
    assert "structural_state" not in names


def test_the_snapshot_records_it_though() -> None:
    """Recorded, so the forward test can segment outcomes by it later."""
    from dataclasses import fields

    from smc.forward_test import SetupSnapshot

    names = {field.name for field in fields(SetupSnapshot)}
    assert "structural_state" in names
    assert "structural_score" in names


def test_the_radar_entry_carries_it_for_display() -> None:
    from dataclasses import fields

    from app.momentum.scanner import RadarEntry

    assert "structural" in {field.name for field in fields(RadarEntry)}
