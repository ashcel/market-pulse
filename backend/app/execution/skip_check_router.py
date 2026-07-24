"""Skip Check router — R2 (EDR 0022 decision 5).

POST /execution/skip-check — return a deterministic, dry-run answer for
(symbol, objective, direction, optional stop) with NO order intent: nothing is
persisted, nothing is placed. Account state is fetched server-side; the client
never supplies balances, positions, or freshness flags.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUserId
from app.database import get_db

from .skip_check_schemas import SkipCheckEnvelope, SkipCheckRequest
from .skip_check_service import assemble_skip_check

router = APIRouter(prefix="/execution/skip-check", tags=["execution"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.post(
    "/",
    response_model=SkipCheckEnvelope,
    summary="Deterministic pre-trade Skip Check (dry-run, no order intent)",
)
async def skip_check_endpoint(
    payload: SkipCheckRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> SkipCheckEnvelope:
    """Assemble the Skip Check answer. Never persists a permit, never places an
    order — a dry-run of the exact deterministic desk a real permit runs."""
    answer = await assemble_skip_check(db=db, user_id=user_id, request=payload)
    return SkipCheckEnvelope(data=answer)
