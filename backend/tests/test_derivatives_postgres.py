"""Append-only enforcement — Postgres only.

The immutability trigger is plpgsql, so sqlite cannot prove it. This module
skips unless `DERIVATIVES_TEST_DATABASE_URL` points at an **isolated** scratch
database that alembic has already been upgraded on. It never falls through to
`DATABASE_URL`: this repo is developed on the production VPS (CLAUDE.md), and
a test that writes to prod because an env var was unset is exactly the failure
mode that guard exists to prevent.

Provision:
    createdb market_pulse_derivtest
    DATABASE_URL=<scratch> alembic upgrade head
    DERIVATIVES_TEST_DATABASE_URL=<scratch> pytest tests/test_derivatives_postgres.py
"""

import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.derivatives import repo

SCRATCH_URL = os.environ.get("DERIVATIVES_TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(
    not SCRATCH_URL,
    reason="DERIVATIVES_TEST_DATABASE_URL not set (never falls back to DATABASE_URL — prod)",
)


@pytest.fixture
async def session() -> AsyncIterator[object]:
    if os.environ.get("DATABASE_URL") == SCRATCH_URL:
        pytest.fail("DERIVATIVES_TEST_DATABASE_URL must differ from DATABASE_URL")
    engine = create_async_engine(SCRATCH_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        yield db
    await engine.dispose()


async def _seed(db: object) -> str:
    symbol = f"TRG{uuid.uuid4().hex[:6].upper()}USDT"
    await repo.insert_snapshots(
        db,  # type: ignore[arg-type]
        [
            {
                "symbol": symbol,
                "timestamp": datetime.now(UTC).replace(microsecond=0),
                "open_interest": 1000.0,
                "price": 100.0,
            }
        ],
    )
    return symbol


async def test_update_is_rejected(session: object) -> None:
    symbol = await _seed(session)
    with pytest.raises(DBAPIError, match="derivatives_snapshot is append-only"):
        await session.execute(  # type: ignore[attr-defined]
            text("UPDATE derivatives_snapshot SET price = 1 WHERE symbol = :s"), {"s": symbol}
        )
    await session.rollback()  # type: ignore[attr-defined]


async def test_delete_is_rejected(session: object) -> None:
    symbol = await _seed(session)
    with pytest.raises(DBAPIError, match="derivatives_snapshot is append-only"):
        await session.execute(  # type: ignore[attr-defined]
            text("DELETE FROM derivatives_snapshot WHERE symbol = :s"), {"s": symbol}
        )
    await session.rollback()  # type: ignore[attr-defined]


async def test_insert_of_a_duplicate_slot_is_dropped_not_raised(session: object) -> None:
    """The real ON CONFLICT DO NOTHING path, on the real unique constraint."""
    symbol = f"TRG{uuid.uuid4().hex[:6].upper()}USDT"
    slot = datetime.now(UTC).replace(microsecond=0)
    row: dict[str, object] = {"symbol": symbol, "timestamp": slot, "open_interest": 1.0}
    assert await repo.insert_snapshots(session, [row]) == 1  # type: ignore[arg-type]
    assert await repo.insert_snapshots(session, [dict(row)]) == 0  # type: ignore[arg-type]


async def test_numeric_columns_round_trip_as_floats(session: object) -> None:
    symbol = f"TRG{uuid.uuid4().hex[:6].upper()}USDT"
    await repo.insert_snapshots(
        session,  # type: ignore[arg-type]
        [
            {
                "symbol": symbol,
                "timestamp": datetime.now(UTC).replace(microsecond=0),
                "funding_rate": 0.000123456789,
                "open_interest_usd": 8_400_050_000.0,
            }
        ],
    )
    series = await repo.load_series(session, symbol, lookback_s=3600)  # type: ignore[arg-type]
    assert isinstance(series[0].funding_rate, float)
    assert series[0].funding_rate == pytest.approx(0.000123456789)
    assert series[0].open_interest_usd == pytest.approx(8_400_050_000.0)
