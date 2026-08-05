"""The only SQL surface for `forward_return`.

Writes are INSERT-only — the DB trigger would reject anything else. Reads
hydrate Postgres `numeric` (asyncpg hands it back as `Decimal`) into plain
floats once, here, so the statistics layer never sees two numeric types.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import CursorResult, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .constants import FORWARD_RETURN_VERSION
from .forward_returns import ForwardReturnRow
from .models import ForwardReturn


def _float(value: float | Decimal) -> float:
    return float(value)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def row_to_values(row: ForwardReturnRow) -> dict[str, object]:
    return {
        "id": str(uuid.uuid4()),
        "symbol": row.symbol,
        "observed_at": row.observed_at,
        "horizon": row.horizon,
        "horizon_bars": row.horizon_bars,
        "interval": row.interval,
        "base_close": row.base_close,
        "forward_close": row.forward_close,
        "forward_return": row.forward_return,
        "version": row.version,
    }


async def insert_forward_returns(db: AsyncSession, rows: Iterable[ForwardReturnRow]) -> int:
    """Append rows, dropping any `(symbol, observed_at, horizon, version)` that
    already exists.

    ON CONFLICT DO NOTHING is what makes re-running the pass free: overlapping
    kline windows re-derive the same measurements from the same closed bars, so
    a repeat lands on this clause instead of duplicating a fact. Returns how
    many were actually new.
    """
    payload = [row_to_values(row) for row in rows]
    if not payload:
        return 0

    dialect = db.get_bind().dialect.name
    maker = pg_insert if dialect == "postgresql" else sqlite_insert
    statement = (
        maker(ForwardReturn)
        .values(payload)
        .on_conflict_do_nothing(
            index_elements=[
                ForwardReturn.symbol,
                ForwardReturn.observed_at,
                ForwardReturn.horizon,
                ForwardReturn.version,
            ]
        )
    )
    result = await db.execute(statement)
    await db.commit()
    # `rowcount` after ON CONFLICT DO NOTHING is the count actually inserted —
    # the whole point of returning it. It lives on CursorResult, which
    # `execute` types only as Result.
    return int(cast("CursorResult[Any]", result).rowcount or 0)


async def latest_observed_at(
    db: AsyncSession, symbol: str, version: str = FORWARD_RETURN_VERSION
) -> datetime | None:
    """Newest anchor bar already measured for `symbol`, so a pass can fetch
    only the window it still needs. None when the symbol has no rows yet."""
    result = await db.execute(
        select(ForwardReturn.observed_at)
        .where(ForwardReturn.symbol == symbol, ForwardReturn.version == version)
        .order_by(ForwardReturn.observed_at.desc())
        .limit(1)
    )
    found = result.scalar_one_or_none()
    return None if found is None else _aware(found)


async def list_returns(
    db: AsyncSession,
    horizon: str,
    since: datetime,
    until: datetime | None = None,
    version: str = FORWARD_RETURN_VERSION,
) -> Sequence[tuple[str, datetime, float]]:
    """`(symbol, observed_at, forward_return)` for one horizon over a window —
    the shape the IC pass ranks. Ordered by bar so a caller can group by
    timestamp without re-sorting."""
    query = select(
        ForwardReturn.symbol, ForwardReturn.observed_at, ForwardReturn.forward_return
    ).where(
        ForwardReturn.horizon == horizon,
        ForwardReturn.version == version,
        ForwardReturn.observed_at >= since,
    )
    if until is not None:
        query = query.where(ForwardReturn.observed_at <= until)

    result = await db.execute(query.order_by(ForwardReturn.observed_at))
    return [(symbol, _aware(at), _float(value)) for symbol, at, value in result.all()]
