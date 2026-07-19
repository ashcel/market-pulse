from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .exceptions import ConstitutionNotFoundError, ConstitutionValidationError
from .models import ConstitutionAudit, TradingConstitution
from .schemas import ConstitutionCreate
from .validation import validate_constitution


async def _get_latest_or_none(db: AsyncSession, user_id: str) -> TradingConstitution | None:
    result = await db.execute(
        select(TradingConstitution)
        .where(TradingConstitution.user_id == user_id)
        .order_by(TradingConstitution.version.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def get_current_constitution(db: AsyncSession, user_id: str) -> TradingConstitution:
    """The active config: the highest-`version` row for this user."""
    constitution = await _get_latest_or_none(db, user_id)
    if constitution is None:
        raise ConstitutionNotFoundError(user_id)
    return constitution


async def list_constitution_history(
    db: AsyncSession,
    user_id: str,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[TradingConstitution], int]:
    offset = (page - 1) * per_page
    count_q = select(func.count(TradingConstitution.id)).where(
        TradingConstitution.user_id == user_id
    )
    total = (await db.execute(count_q)).scalar() or 0

    q = (
        select(TradingConstitution)
        .where(TradingConstitution.user_id == user_id)
        .order_by(TradingConstitution.version.desc())
        .offset(offset)
        .limit(per_page)
    )
    result = await db.execute(q)
    return list(result.scalars().all()), total


def _snapshot(constitution: TradingConstitution) -> dict[str, Any]:
    """Plain-dict snapshot of a constitution row for the audit before/after."""
    return {
        "version": constitution.version,
        "risk_per_trade_percent": constitution.risk_per_trade_percent,
        "daily_loss_limit_percent": constitution.daily_loss_limit_percent,
        "weekly_loss_limit_percent": constitution.weekly_loss_limit_percent,
        "max_leverage": constitution.max_leverage,
        "max_concurrent_positions": constitution.max_concurrent_positions,
        "max_correlated_exposure_percent": constitution.max_correlated_exposure_percent,
        "min_risk_reward": constitution.min_risk_reward,
        "allowed_sessions": list(constitution.allowed_sessions),
        "allowed_symbols": list(constitution.allowed_symbols),
        "binding_cooldowns": dict(constitution.binding_cooldowns),
    }


async def create_constitution_version(
    db: AsyncSession,
    user_id: str,
    payload: ConstitutionCreate,
    changed_by_user_id: str | None = None,
) -> TradingConstitution:
    """Validate, then insert the next version and its audit row atomically.

    Every create/update writes exactly one `ConstitutionAudit` row in the
    same transaction — never committed independently, so a constitution
    version can never exist without its audit trail entry (or vice versa).
    """
    errors = validate_constitution(payload)
    if errors:
        raise ConstitutionValidationError(errors)

    previous = await _get_latest_or_none(db, user_id)
    next_version = previous.version + 1 if previous else 1

    constitution = TradingConstitution(
        user_id=user_id,
        version=next_version,
        risk_per_trade_percent=payload.risk_per_trade_percent,
        daily_loss_limit_percent=payload.daily_loss_limit_percent,
        weekly_loss_limit_percent=payload.weekly_loss_limit_percent,
        max_leverage=payload.max_leverage,
        max_concurrent_positions=payload.max_concurrent_positions,
        max_correlated_exposure_percent=payload.max_correlated_exposure_percent,
        min_risk_reward=payload.min_risk_reward,
        allowed_sessions=list(payload.allowed_sessions),
        allowed_symbols=[s.upper() for s in payload.allowed_symbols],
        binding_cooldowns=dict(payload.binding_cooldowns),
    )
    db.add(constitution)
    await db.flush()  # assign constitution.id before building the audit row

    audit = ConstitutionAudit(
        user_id=user_id,
        constitution_id=constitution.id,
        version=constitution.version,
        action="create" if previous is None else "update",
        changed_by_user_id=changed_by_user_id or user_id,
        before_snapshot=_snapshot(previous) if previous else None,
        after_snapshot=_snapshot(constitution),
    )
    db.add(audit)

    await db.commit()
    await db.refresh(constitution)
    return constitution


async def list_constitution_audits(
    db: AsyncSession,
    user_id: str,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[ConstitutionAudit], int]:
    offset = (page - 1) * per_page
    count_q = select(func.count(ConstitutionAudit.id)).where(
        ConstitutionAudit.user_id == user_id
    )
    total = (await db.execute(count_q)).scalar() or 0

    q = (
        select(ConstitutionAudit)
        .where(ConstitutionAudit.user_id == user_id)
        .order_by(ConstitutionAudit.version.desc())
        .offset(offset)
        .limit(per_page)
    )
    result = await db.execute(q)
    return list(result.scalars().all()), total
