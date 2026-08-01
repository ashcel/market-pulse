"""The only SQL surface for `signal_events` — one insert plus reads.

There is intentionally no update and no delete here. That is not a convention
to be argued with later: the table carries a trigger that raises
`signal_events is append-only`, so a correction is a new event, and any code
that tries otherwise fails loudly at the database.

`insert_signal` is idempotent through `ON CONFLICT (dedup_key) DO NOTHING`,
which is what makes the writer safe to retry (R5) and the 48h dual-run
reconciliation countable.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

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
    (the retry/duplicate case) — never an error.

    `status` defaults to 'shadow' on purpose: a writer never promotes itself.
    Callers pass 'live' only after checking the operator's allowlist (see
    `status_for_source`), and promotion is otherwise a scorecard decision.
    """
    stmt = (
        _insert_for(db)(SignalEvent)
        .values(
            id=id,
            status=status,
            context_ref=context_ref,
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
        )
        .on_conflict_do_nothing(index_elements=["dedup_key"])
        .returning(SignalEvent.id)
    )
    inserted_id = (await db.execute(stmt)).scalar_one_or_none()
    await db.commit()
    return inserted_id is not None


def status_for_source(source: str) -> str:
    """'live' when the operator's allowlist already trusts this source, else
    'shadow'. The one place the promotion rule is written down."""
    from app.config import settings

    return "live" if source in (settings.SIGNAL_SOURCES_LIVE or []) else "shadow"


def _list_query(
    *,
    since: datetime,
    symbol: str | None = None,
    sources: list[str] | None = None,
    horizon: str | None = None,
    status: str | None = None,
    limit: int = 500,
) -> Select[tuple[SignalEvent]]:
    query = select(SignalEvent).where(SignalEvent.detected_at >= since)
    if symbol:
        query = query.where(SignalEvent.symbol == symbol.upper())
    if sources:
        query = query.where(SignalEvent.source.in_(sources))
    if horizon:
        query = query.where(SignalEvent.horizon == horizon)
    if status:
        query = query.where(SignalEvent.status == status)
    return query.order_by(SignalEvent.detected_at.desc()).limit(limit)


async def list_signals(
    db: AsyncSession,
    *,
    since: datetime,
    symbol: str | None = None,
    sources: list[str] | None = None,
    horizon: str | None = None,
    status: str | None = None,
    limit: int = 500,
) -> list[SignalEvent]:
    result = await db.execute(
        _list_query(
            since=since,
            symbol=symbol,
            sources=sources,
            horizon=horizon,
            status=status,
            limit=limit,
        )
    )
    return list(result.scalars())
