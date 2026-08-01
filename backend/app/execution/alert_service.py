from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .alert_models import Alert, AlertSeverity, AlertType


@dataclass(frozen=True)
class AlertCandidate:
    user_id: str
    type: AlertType
    token_symbol: str
    title: str
    body: str
    severity: AlertSeverity
    dedupe_key: str
    source_decision_id: str | None = None
    source: str = "market_pulse"
    delivery_state: str = "pending"


class EntryZoneAlert(AlertCandidate):
    pass


class VerdictChangeAlert(AlertCandidate):
    pass


class InvalidationAlert(AlertCandidate):
    pass


class CatalystAlert(AlertCandidate):
    pass


class BehaviorCooldownAlert(AlertCandidate):
    pass


async def create_alerts(db: AsyncSession, candidates: list[AlertCandidate]) -> int:
    if not candidates:
        return 0
    keys = [candidate.dedupe_key for candidate in candidates]
    existing = set(
        (await db.execute(select(Alert.dedupe_key).where(Alert.dedupe_key.in_(keys)))).scalars()
    )
    rows = [
        Alert(
            user_id=item.user_id,
            type=item.type.value,
            token_symbol=item.token_symbol,
            title=item.title,
            body=item.body,
            severity=item.severity.value,
            source_decision_id=item.source_decision_id,
            dedupe_key=item.dedupe_key,
            source=item.source,
            delivery_state=item.delivery_state,
        )
        for item in candidates
        if item.dedupe_key not in existing
    ]
    db.add_all(rows)
    await db.commit()
    return len(rows)


async def list_alerts(
    db: AsyncSession, user_id: str, page: int, per_page: int, unread: bool | None
) -> tuple[list[Alert], int]:
    filters: list[Any] = [Alert.user_id == user_id]
    if unread is not None:
        filters.append(Alert.read.is_(not unread) if not unread else Alert.read.is_(False))
    total = (await db.execute(select(func.count(Alert.id)).where(*filters))).scalar() or 0
    rows = await db.execute(
        select(Alert)
        .where(*filters)
        .order_by(Alert.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
    )
    return list(rows.scalars()), total


async def mark_read(db: AsyncSession, user_id: str, alert_id: str) -> Alert | None:
    alert = (
        await db.execute(select(Alert).where(Alert.id == alert_id, Alert.user_id == user_id))
    ).scalar_one_or_none()
    if alert is None:
        return None
    alert.read = True
    alert.delivered_at = alert.delivered_at or datetime.now(UTC)
    await db.commit()
    await db.refresh(alert)
    return alert


async def mark_all_read(db: AsyncSession, user_id: str) -> int:
    result = await db.execute(
        update(Alert)
        .where(Alert.user_id == user_id, Alert.read.is_(False))
        .values(read=True, delivered_at=datetime.now(UTC))
    )
    await db.commit()
    return int(result.rowcount or 0)


def danger_window(now: datetime) -> datetime:
    return now.astimezone(UTC) + timedelta(hours=24)
