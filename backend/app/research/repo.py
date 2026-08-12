"""The only SQL surface for the Discover forward test.

Three operations, and the shape of them is the no-lookahead guarantee:

* `insert_setup` writes the hypothesis **once**, `ON CONFLICT DO NOTHING` on
  the dedup key, so a scanner restart or a repeated poll can never mint a
  second row for the same situation.
* `update_lifecycle` is the *only* update, and its column list contains no
  detection-time field. There is deliberately no generic "save this record"
  helper here: the absence of one is what stops a later refactor quietly
  rewriting a target with hindsight.
* `insert_events` is append-only.

Reads are separate and total: they never mutate.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ForwardTestEvent, ForwardTestSetup

#: Columns the lifecycle is allowed to touch. Detection-time fields are absent
#: by design — see the module docstring.
LIFECYCLE_COLUMNS = frozenset(
    {
        "status",
        "zone_touched_at",
        "entered_at",
        "entry_price",
        "active_stop",
        "trailing_activated_at",
        "trailing_updates",
        "settled_at",
        "exit_price",
        "exit_reason",
        "realized_r",
        "mfe_pct",
        "mae_pct",
        "mfe_r",
        "mae_r",
        "pending_mfe_pct",
        "pending_mae_pct",
        "touched_zone",
        "event_count",
        "last_price",
        "updated_at",
    }
)


def to_utc(ts: float | None) -> datetime | None:
    """Epoch seconds → aware UTC. The engine works in floats; the database
    stores instants."""
    if ts is None or ts <= 0:
        return None
    return datetime.fromtimestamp(ts, tz=UTC)


def from_utc(value: datetime | None) -> float | None:
    """Instant → epoch seconds. A naive datetime is read as UTC rather than
    silently picking up the server's local zone — that offset would shift
    `detected_at` and with it every duration and entry window on the record."""
    if value is None:
        return None
    aware = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return aware.timestamp()


def _insert_for(db: AsyncSession) -> Any:
    """Both dialects we run on implement ON CONFLICT DO NOTHING; pick the one
    matching the bind so the unit tests (sqlite) exercise the same code path
    as production (postgres)."""
    dialect = db.get_bind().dialect.name
    return pg_insert if dialect == "postgresql" else sqlite_insert


async def insert_setup(db: AsyncSession, values: dict[str, Any]) -> str | None:
    """Records a new hypothesis. Returns its id, or `None` when the dedup key
    already exists — which is the normal case on every poll after the first."""
    statement = (
        _insert_for(db)(ForwardTestSetup)
        .values(**values)
        .on_conflict_do_nothing(index_elements=[ForwardTestSetup.setup_key])
        .returning(ForwardTestSetup.id)
    )
    result = await db.execute(statement)
    row = result.scalar_one_or_none()
    await db.commit()
    return str(row) if row is not None else None


async def find_id(db: AsyncSession, setup_key: str) -> str | None:
    result = await db.execute(
        select(ForwardTestSetup.id).where(ForwardTestSetup.setup_key == setup_key)
    )
    row = result.scalar_one_or_none()
    return str(row) if row is not None else None


async def find_row(db: AsyncSession, setup_key: str) -> ForwardTestSetup | None:
    """The whole row, so a caller can decide whether it is still open and
    rebuild its lifecycle rather than starting a new one."""
    result = await db.execute(
        select(ForwardTestSetup).where(ForwardTestSetup.setup_key == setup_key)
    )
    return result.scalars().first()


async def update_lifecycle(db: AsyncSession, setup_id: str, values: dict[str, Any]) -> None:
    """Advances a record's lifecycle and outcome.

    Silently ignores any key outside `LIFECYCLE_COLUMNS`: a caller that tries
    to "correct" a target through this door gets no effect rather than a
    corrupted dataset.
    """
    allowed = {key: value for key, value in values.items() if key in LIFECYCLE_COLUMNS}
    if not allowed:
        return
    setup = await db.get(ForwardTestSetup, setup_id)
    if setup is None:
        return
    for key, value in allowed.items():
        setattr(setup, key, value)
    await db.commit()


async def insert_events(db: AsyncSession, rows: list[dict[str, Any]]) -> int:
    """Appends lifecycle events. Never updates, never deletes."""
    if not rows:
        return 0
    db.add_all([ForwardTestEvent(**row) for row in rows])
    await db.commit()
    return len(rows)


# ── reads ────────────────────────────────────────────────────────────────────


def _generation(statement: Select[Any], generation: int | None) -> Select[Any]:
    """Restricts a query to one detector generation.

    Results from different detector geometry are different experiments. Pooling
    them produces a number that describes neither, so the read model segments
    by default and only merges when a caller explicitly asks for everything.
    """
    if generation is None:
        return statement
    # `as_integer` rather than a string compare: SQLite's JSON_EXTRACT returns
    # a number and would never match a quoted one.
    return statement.where(ForwardTestSetup.versions["generation"].as_integer() == generation)


def _feed(mode: str | None, status: str | None, generation: int | None = None) -> Select[Any]:
    statement = select(ForwardTestSetup).order_by(ForwardTestSetup.detected_at.desc())
    if mode:
        statement = statement.where(ForwardTestSetup.mode == mode)
    if status:
        statement = statement.where(ForwardTestSetup.status == status)
    return _generation(statement, generation)


async def list_setups(
    db: AsyncSession,
    *,
    mode: str | None = None,
    status: str | None = None,
    generation: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[ForwardTestSetup]:
    result = await db.execute(_feed(mode, status, generation).limit(limit).offset(offset))
    return list(result.scalars().all())


async def count_setups(
    db: AsyncSession, *, mode: str | None = None, generation: int | None = None
) -> int:
    statement = select(func.count()).select_from(ForwardTestSetup)
    if mode:
        statement = statement.where(ForwardTestSetup.mode == mode)
    statement = _generation(statement, generation)
    result = await db.execute(statement)
    return int(result.scalar_one())


async def outcome_rows(
    db: AsyncSession, *, mode: str | None = None, generation: int | None = None
) -> list[tuple[str, float, float, float]]:
    """`(status, realized_r, mfe_r, mae_r)` for the statistics engine, in
    detection order so the drawdown curve is chronological."""
    statement = select(
        ForwardTestSetup.status,
        ForwardTestSetup.realized_r,
        ForwardTestSetup.mfe_r,
        ForwardTestSetup.mae_r,
    ).order_by(ForwardTestSetup.detected_at.asc())
    if mode:
        statement = statement.where(ForwardTestSetup.mode == mode)
    statement = _generation(statement, generation)
    result = await db.execute(statement)
    return [(str(row[0]), float(row[1]), float(row[2]), float(row[3])) for row in result.all()]


async def best_setup(
    db: AsyncSession, *, mode: str | None = None, generation: int | None = None
) -> ForwardTestSetup | None:
    statement = (
        select(ForwardTestSetup)
        .where(ForwardTestSetup.status.in_(("TARGET_HIT", "INVALIDATED", "EXPIRED")))
        .order_by(ForwardTestSetup.realized_r.desc())
        .limit(1)
    )
    if mode:
        statement = statement.where(ForwardTestSetup.mode == mode)
    statement = _generation(statement, generation)
    result = await db.execute(statement)
    return result.scalars().first()


async def first_detection(
    db: AsyncSession, *, mode: str | None = None, generation: int | None = None
) -> datetime | None:
    """When the forward test started — what "days running" counts from."""
    statement = select(func.min(ForwardTestSetup.detected_at))
    if mode:
        statement = statement.where(ForwardTestSetup.mode == mode)
    statement = _generation(statement, generation)
    result = await db.execute(statement)
    return result.scalar_one_or_none()


async def events_for(db: AsyncSession, setup_id: str) -> list[ForwardTestEvent]:
    result = await db.execute(
        select(ForwardTestEvent)
        .where(ForwardTestEvent.setup_id == setup_id)
        .order_by(ForwardTestEvent.ts.asc())
    )
    return list(result.scalars().all())


async def open_setups(db: AsyncSession) -> list[ForwardTestSetup]:
    """Everything still being observed — what the recorder reloads after a
    restart so an in-flight hypothesis is not silently abandoned."""
    result = await db.execute(
        select(ForwardTestSetup).where(ForwardTestSetup.status.in_(("PENDING_ENTRY", "ACTIVE")))
    )
    return list(result.scalars().all())
