"""Read-only Execution Records router — Trade Review surfacing (M9 follow-up).

GET /execution/executions — list the current user's execution records,
most recent first. This is additive and read-only: it never creates,
updates, or deletes an `ExecutionRecord` row (that remains
`order_service.py`'s job). Exposes only fields that exist on the model —
there is no exit price or realized PnL to report (see `models.py`).
"""

from typing import Annotated

import sqlalchemy as sa
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUserId
from app.database import get_db

from .models import ExecutionRecord

router = APIRouter(prefix="/execution/executions", tags=["execution"])

DbSession = Annotated[AsyncSession, Depends(get_db)]

DEFAULT_LIMIT = 100


class ExecutionRecordSummary(BaseModel):
    """Order-placement facts only — never a realized-PnL/exit-price claim."""

    id: str
    symbol: str
    side: str
    entry_type: str
    entry_price: float
    stop_price: float
    target_price: float | None
    quantity: float
    filled_quantity: float
    leverage: float
    status: str
    entry_order_id: str | None
    flattened: bool
    created_at: str


class ExecutionRecordListEnvelope(BaseModel):
    data: list[ExecutionRecordSummary]
    meta: dict[str, int]
    error: None = None


def _to_summary(record: ExecutionRecord) -> ExecutionRecordSummary:
    return ExecutionRecordSummary(
        id=record.id,
        symbol=record.symbol,
        side=record.side,
        entry_type=record.entry_type,
        entry_price=record.entry_price,
        stop_price=record.stop_price,
        target_price=record.target_price,
        quantity=record.quantity,
        filled_quantity=record.filled_quantity,
        leverage=record.leverage,
        status=record.status,
        entry_order_id=record.entry_order_id,
        flattened=record.flattened,
        created_at=record.created_at.isoformat(),
    )


@router.get(
    "/",
    response_model=ExecutionRecordListEnvelope,
    summary="List the current user's execution records, newest first",
)
async def list_executions_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
) -> ExecutionRecordListEnvelope:
    """Recent execution (order-placement) records for the Trade Review page.

    Read-only and user-scoped. These are order-submission facts, not
    PnL-settled trades — there is no exit price or realized PnL on
    `ExecutionRecord` to report.
    """
    result = await db.execute(
        sa.select(ExecutionRecord)
        .where(ExecutionRecord.user_id == user_id)
        .order_by(ExecutionRecord.created_at.desc())
        .limit(DEFAULT_LIMIT)
    )
    records = result.scalars().all()
    return ExecutionRecordListEnvelope(
        data=[_to_summary(r) for r in records],
        meta={"total": len(records), "limit": DEFAULT_LIMIT},
    )
