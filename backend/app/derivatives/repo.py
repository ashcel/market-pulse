"""The only SQL surface for `derivatives_snapshot`.

Reads hydrate Postgres `numeric` (which asyncpg hands back as `Decimal`) into
plain floats once, here, so `service.py` never has to think about two numeric
types. Writes are INSERT-only: there is no update path in this module, and the
DB trigger would reject one anyway.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import CursorResult, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .models import DerivativesSnapshot
from .service import SnapshotPoint


def _float(value: float | Decimal | None) -> float | None:
    return None if value is None else float(value)


def _row_to_point(row: DerivativesSnapshot) -> SnapshotPoint:
    timestamp = row.timestamp
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    return SnapshotPoint(
        timestamp=timestamp,
        price=_float(row.price),
        open_interest=_float(row.open_interest),
        open_interest_usd=_float(row.open_interest_usd),
        funding_rate=_float(row.funding_rate),
        long_short_ratio=_float(row.long_short_ratio),
        top_trader_accounts_ratio=_float(row.top_trader_accounts_ratio),
        top_trader_positions_ratio=_float(row.top_trader_positions_ratio),
        taker_buy_volume=_float(row.taker_buy_volume),
        taker_sell_volume=_float(row.taker_sell_volume),
        basis=_float(row.basis),
        premium=_float(row.premium),
        oi_marketcap_ratio=_float(row.oi_marketcap_ratio),
    )


async def load_series(
    db: AsyncSession,
    symbol: str,
    *,
    lookback_s: int,
    now: datetime | None = None,
) -> list[SnapshotPoint]:
    """Ascending series for one symbol. Ascending because every derivation in
    `service.py` walks forward in time; sorting at the edge means no caller
    can get the direction wrong."""
    cutoff = (now or datetime.now(UTC)) - timedelta(seconds=lookback_s)
    result = await db.execute(
        select(DerivativesSnapshot)
        .where(
            DerivativesSnapshot.symbol == symbol,
            DerivativesSnapshot.timestamp >= cutoff,
        )
        .order_by(DerivativesSnapshot.timestamp.asc())
    )
    return [_row_to_point(row) for row in result.scalars().all()]


async def has_symbol(db: AsyncSession, symbol: str) -> bool:
    """Whether anything was EVER collected for this symbol — the difference
    between "unknown symbol" (404) and "collected but nothing recent"."""
    result = await db.execute(
        select(DerivativesSnapshot.id).where(DerivativesSnapshot.symbol == symbol).limit(1)
    )
    return result.scalar_one_or_none() is not None


async def count_since(db: AsyncSession, symbol: str, since: datetime) -> int:
    result = await db.execute(
        select(DerivativesSnapshot.id).where(
            DerivativesSnapshot.symbol == symbol,
            DerivativesSnapshot.timestamp >= since,
        )
    )
    return len(result.scalars().all())


async def insert_snapshots(db: AsyncSession, rows: Iterable[dict[str, object]]) -> int:
    """Append rows, dropping any `(symbol, timestamp)` that already exists.

    ON CONFLICT DO NOTHING is what makes a retried tick free: the writer floors
    every timestamp onto the 5-minute grid, so a re-run inside the same slot
    re-derives the same key and lands on this clause instead of duplicating a
    fact. Returns how many were actually new.
    """
    payload = [dict(row, id=row.get("id") or str(uuid.uuid4())) for row in rows]
    if not payload:
        return 0

    dialect = db.get_bind().dialect.name
    maker = pg_insert if dialect == "postgresql" else sqlite_insert
    statement = (
        maker(DerivativesSnapshot)
        .values(payload)
        .on_conflict_do_nothing(
            index_elements=[DerivativesSnapshot.symbol, DerivativesSnapshot.timestamp]
        )
    )
    result = await db.execute(statement)
    await db.commit()
    # `rowcount` after ON CONFLICT DO NOTHING is the count of rows that were
    # actually inserted — the whole point of returning it. It lives on
    # CursorResult, which `execute` types only as Result.
    return int(cast("CursorResult[Any]", result).rowcount or 0)


async def list_symbols(db: AsyncSession) -> Sequence[str]:
    result = await db.execute(select(DerivativesSnapshot.symbol).distinct())
    return list(result.scalars().all())
