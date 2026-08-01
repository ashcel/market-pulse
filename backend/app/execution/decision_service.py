from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .decision_snapshot import DecisionSnapshot


async def create_decision(
    db: AsyncSession, user_id: str, values: dict[str, Any]
) -> DecisionSnapshot:
    decision = DecisionSnapshot(user_id=user_id, **values)
    db.add(decision)
    await db.commit()
    await db.refresh(decision)
    return decision


async def get_decision(db: AsyncSession, user_id: str, decision_id: str) -> DecisionSnapshot | None:
    result = await db.execute(
        select(DecisionSnapshot).where(
            DecisionSnapshot.id == decision_id,
            DecisionSnapshot.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


async def list_decisions(
    db: AsyncSession,
    user_id: str,
    *,
    symbol: str | None = None,
    objective: str | None = None,
    user_action: str | None = None,
    page: int = 1,
    per_page: int = 50,
) -> tuple[list[DecisionSnapshot], int]:
    filters = [DecisionSnapshot.user_id == user_id]
    if symbol:
        filters.append(DecisionSnapshot.symbol == symbol.upper())
    if objective:
        filters.append(DecisionSnapshot.objective == objective)
    if user_action:
        filters.append(DecisionSnapshot.user_action == user_action)
    count_result = await db.execute(select(func.count(DecisionSnapshot.id)).where(*filters))
    total = count_result.scalar() or 0
    result = await db.execute(
        select(DecisionSnapshot)
        .where(*filters)
        .order_by(DecisionSnapshot.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
    )
    return list(result.scalars().all()), total


async def record_decision_action(
    db: AsyncSession,
    decision: DecisionSnapshot,
    user_action: str,
    actual_outcome: dict[str, Any] | None,
    skip_reason: str | None = None,
) -> DecisionSnapshot:
    decision.user_action = user_action
    decision.decided_at = datetime.now()
    if skip_reason is not None:
        decision.skip_reason = skip_reason
    if actual_outcome is not None:
        decision.actual_outcome = {**(decision.actual_outcome or {}), **actual_outcome}
    await db.commit()
    await db.refresh(decision)
    return decision
