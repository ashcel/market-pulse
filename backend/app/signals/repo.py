"""The only SQL surface for `signal_events` — one insert plus reads.

There is intentionally no update and no delete here. That is not a convention
to be argued with later: the table carries a trigger that raises
`signal_events is append-only`, so a correction is a new event, and any code
that tries otherwise fails loudly at the database.

`insert_signal` is idempotent through `ON CONFLICT (dedup_key) DO NOTHING`,
which is what makes a detector safe to retry against the same bar/day.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from .models import SignalEvent


def _insert_for(db: AsyncSession) -> Any:
    """Both dialects we run on implement ON CONFLICT DO NOTHING; pick the one
    matching the bind so the unit tests (sqlite) exercise the same code path
    as production (postgres)."""
    dialect = db.get_bind().dialect.name
    return pg_insert if dialect == "postgresql" else sqlite_insert


async def insert_signal(
    db: AsyncSession,
    *,
    id: str,
    source: str,
    source_version: str,
    symbol: str,
    side: str,
    horizon: str,
    kind: str,
    conviction: str | None,
    detected_at: datetime,
    expires_at: datetime | None,
    features: dict[str, Any],
    dedup_key: str,
    status: str = "shadow",
    context_ref: dict[str, Any] | None = None,
) -> bool:
    """Append one signal fact. Returns False when `dedup_key` already exists
    (the retry/duplicate case) — never an error."""
    stmt = (
        _insert_for(db)(SignalEvent)
        .values(
            id=id,
            source=source,
            source_version=source_version,
            symbol=symbol,
            side=side,
            horizon=horizon,
            kind=kind,
            conviction=conviction,
            detected_at=detected_at,
            expires_at=expires_at,
            features=features,
            dedup_key=dedup_key,
            status=status,
            context_ref=context_ref,
        )
        .on_conflict_do_nothing(index_elements=["dedup_key"])
        .returning(SignalEvent.id)
    )
    inserted_id = (await db.execute(stmt)).scalar_one_or_none()
    await db.commit()
    return inserted_id is not None


def _list_query(
    *,
    source: str | None = None,
    symbol: str | None = None,
    limit: int | None = 20,
) -> Select[tuple[SignalEvent]]:
    """Base filtered-and-ordered query (detected_at DESC), no dedup/re-sort.
    Used as-is for the plain "recent" read on every dialect, and as the raw
    fetch that the sqlite screening path below re-derives in Python."""
    query = select(SignalEvent)
    if source:
        query = query.where(SignalEvent.source == source)
    if symbol:
        query = query.where(SignalEvent.symbol == symbol.upper())
    query = query.order_by(SignalEvent.detected_at.desc())
    if limit is not None:
        query = query.limit(limit)
    return query


async def list_signals(
    db: AsyncSession,
    *,
    source: str | None = None,
    symbol: str | None = None,
    limit: int = 20,
    latest_per_symbol: bool = False,
    sort: str = "recent",
    state: str | None = None,
) -> list[SignalEvent]:
    """Recent (default) or screening read over `signal_events`.

    `latest_per_symbol`/`sort="score"`/`state` exist for the REACCUMULATION
    discover-page card: one ranked row per symbol, best score first, optionally
    narrowed to a single `features["state"]`. Postgres runs this as SQL
    (`ROW_NUMBER() OVER (PARTITION BY symbol ...)` + `features->>'score'`/
    `'state'` extraction via the dialect-portable `.as_float()`/`.as_string()`
    JSON comparators — the JSONB-only `.astext` accessor isn't reachable
    through this column's `with_variant` type); sqlite — the unit-test
    dialect — dedups/sorts/filters the same semantics in Python instead. Both
    paths apply the state filter before dedup, so `latest_per_symbol` means
    "this symbol's latest row *in that state*", not "this symbol's latest row
    overall, then check its state".
    """
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        return await _list_signals_postgres(
            db,
            source=source,
            symbol=symbol,
            limit=limit,
            latest_per_symbol=latest_per_symbol,
            sort=sort,
            state=state,
        )

    result = await db.execute(_list_query(source=source, symbol=symbol, limit=None))
    rows = list(result.scalars())
    if state is not None:
        rows = [r for r in rows if (r.features or {}).get("state") == state]
    if latest_per_symbol:
        seen: set[str] = set()
        deduped: list[SignalEvent] = []
        for r in rows:  # already detected_at DESC, so the first hit per symbol wins
            if r.symbol not in seen:
                seen.add(r.symbol)
                deduped.append(r)
        rows = deduped
    if sort == "score":
        rows.sort(key=lambda r: float((r.features or {}).get("score", 0) or 0), reverse=True)
    return rows[:limit]


async def _list_signals_postgres(
    db: AsyncSession,
    *,
    source: str | None,
    symbol: str | None,
    limit: int,
    latest_per_symbol: bool,
    sort: str,
    state: str | None,
) -> list[SignalEvent]:
    base = select(SignalEvent)
    if source:
        base = base.where(SignalEvent.source == source)
    if symbol:
        base = base.where(SignalEvent.symbol == symbol.upper())
    if state is not None:
        # `.as_string()` is the dialect-portable JSON text-extraction method
        # (works whether the compiled type ends up JSONB or plain JSON) — the
        # postgres-only `.astext` accessor isn't reachable through a
        # `with_variant` column.
        base = base.where(SignalEvent.features["state"].as_string() == state)

    if latest_per_symbol:
        rn = (
            func.row_number()
            .over(partition_by=SignalEvent.symbol, order_by=SignalEvent.detected_at.desc())
            .label("rn")
        )
        ranked = base.add_columns(rn).subquery()
        entity = aliased(SignalEvent, ranked)
        outer = select(entity).where(ranked.c.rn == 1)
        score_col = ranked.c.features["score"].as_float()
        detected_col = ranked.c.detected_at
    else:
        outer = base
        score_col = SignalEvent.features["score"].as_float()
        detected_col = SignalEvent.detected_at

    if sort == "score":
        outer = outer.order_by(score_col.desc())
    else:
        outer = outer.order_by(detected_col.desc())

    result = await db.execute(outer.limit(limit))
    return list(result.scalars())
