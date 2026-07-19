"""Trade Permit repo/service — M9-T5 (EDR 0020 decision 6).

**Insert-only, on purpose.** This module exposes exactly three public
functions: `create_permit`, `get_permit`, `list_permits` — plus the pure
`is_expired` helper. There is deliberately **no update/mutate/delete
function of any kind** for `TradePermit` rows; a permit is a point-in-time
judgment snapshot; if inputs move, a caller creates a *new* permit rather
than revising an old one. `tests/test_execution_permit.py::
test_no_update_path_exists` inspects this module's public names (via
`inspect`) to assert that invariant holds — if you're tempted to add an
`update_permit`/`revise_permit`/`patch_permit` function here, don't; that
test exists specifically to make doing so a deliberate, caught decision,
not an accidental one. See `models.py`'s `TradePermit` docstring for the
DB-level side of this (a real `REVOKE UPDATE` grant is intentionally
deferred — this migration is hand-written and never executed by this
task).

Rejected permits are persisted through the exact same `create_permit`
path as approved ones — there is no separate/optional write for rejections
(EDR 0020 decision 6: "Rejected permits are persisted too").
"""

from dataclasses import asdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Protocol

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .constants import PERMIT_TTL_SECONDS
from .exceptions import PermitNotFoundError
from .models import TradePermit
from .quality_score import TradeQualityScore
from .risk_engine import AccountState, PermitDecision, TradeProposal


def _jsonable(value: Any) -> Any:
    """Recursively coerce a value into something `sa.JSON` can store
    losslessly: `Decimal` -> `str` (never `float`, to avoid binary-float
    representation error on the audit record), `frozenset`/`set` -> a
    sorted list, enums -> their `.value`. Dicts/lists/tuples recurse.
    """
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (frozenset, set)):
        return sorted(_jsonable(v) for v in value)
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "value") and not isinstance(value, (str, int, float, bool)):
        # StrEnum/Enum members (e.g. Side, PermitCheck)
        return value.value
    return value


def _proposal_snapshot(proposal: TradeProposal) -> dict[str, Any]:
    return _jsonable(asdict(proposal))


def _account_state_snapshot(account_state: AccountState) -> dict[str, Any]:
    return _jsonable(asdict(account_state))


def _check_results_snapshot(decision: PermitDecision) -> list[dict[str, Any]]:
    return [
        {"check": result.check.value, "passed": result.passed, "detail": result.detail}
        for result in decision.checks
    ]


def _quality_components_snapshot(quality: TradeQualityScore) -> list[dict[str, Any]]:
    return [
        {
            "component": c.component.value,
            "weight": c.weight,
            "fraction": c.fraction,
            "points": c.points,
            "detail": c.detail,
        }
        for c in quality.components
    ]


async def create_permit(
    db: AsyncSession,
    user_id: str,
    proposal: TradeProposal,
    account_state: AccountState,
    decision: PermitDecision,
    quality: TradeQualityScore,
    *,
    ttl_seconds: int = PERMIT_TTL_SECONDS,
) -> TradePermit:
    """Persist one permit — approved or rejected, always. Insert only: this
    function never looks up an existing row to update; every call creates a
    brand-new, immutable `TradePermit`.

    `ttl_seconds` is applied against `decision.evaluated_at` (never a fresh
    clock read here) so the expiry is reproducible from the persisted
    inputs alone.
    """
    permit = TradePermit(
        user_id=user_id,
        symbol=proposal.symbol,
        side=proposal.side.value,
        proposal_snapshot=_proposal_snapshot(proposal),
        account_state_snapshot=_account_state_snapshot(account_state),
        check_results=_check_results_snapshot(decision),
        status=decision.status.value,
        reasons=[r.value for r in decision.reasons],
        quality_score=quality.total,
        quality_components=_quality_components_snapshot(quality),
        quality_disclaimer=quality.disclaimer,
        evaluated_at=decision.evaluated_at,
        session=decision.session,
        expires_at=decision.evaluated_at + timedelta(seconds=ttl_seconds),
    )
    db.add(permit)
    await db.commit()
    await db.refresh(permit)
    return permit


async def get_permit(db: AsyncSession, permit_id: str) -> TradePermit:
    result = await db.execute(select(TradePermit).where(TradePermit.id == permit_id))
    permit = result.scalar_one_or_none()
    if permit is None:
        raise PermitNotFoundError(permit_id)
    return permit


async def list_permits(
    db: AsyncSession,
    user_id: str,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[TradePermit], int]:
    offset = (page - 1) * per_page
    count_q = select(func.count(TradePermit.id)).where(TradePermit.user_id == user_id)
    total = (await db.execute(count_q)).scalar() or 0

    q = (
        select(TradePermit)
        .where(TradePermit.user_id == user_id)
        .order_by(TradePermit.created_at.desc())
        .offset(offset)
        .limit(per_page)
    )
    result = await db.execute(q)
    return list(result.scalars().all()), total


class _ExpiryLike(Protocol):
    expires_at: datetime


def is_expired(permit: _ExpiryLike, now: datetime) -> bool:
    """Pure TTL check: `now` is always caller-supplied, never read from a
    clock in here — mirrors `risk_engine.evaluate_permit`'s `now` convention
    so this stays unit-testable without freezing time. `permit` only needs
    an `expires_at` attribute (a real `TradePermit` row or a lightweight
    fixture both satisfy this structurally).
    """
    return now >= permit.expires_at
