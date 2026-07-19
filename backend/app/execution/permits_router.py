"""Permits router — M9 (EDR 0020 decision 6).

POST /execution/permits — request a Trade Permit (approved or rejected).
GET  /execution/permits/{permit_id} — fetch a persisted permit.
GET  /execution/permits — list permits for the current user.

The POST endpoint is the main execution gate: it accepts a trade ticket,
fetches account state server-side, runs the risk engine + quality score,
persists the permit, and returns the permit card.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUserId
from app.database import get_db
from app.pagination import PaginationMeta

from .permit_request_schemas import PermitRequest
from .permit_request_service import request_permit
from .permit_service import get_permit, list_permits
from .schemas import (
    PermitCardApproved,
    PermitCardRejected,
)

router = APIRouter(prefix="/execution/permits", tags=["execution"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


class PermitRequestBody(BaseModel):
    """Request body: only the trade ticket.

    Account state is never accepted from the client. Permit issuance fetches
    account state from server-side sources only.
    """

    proposal: PermitRequest


class PermitIssuedEnvelope(BaseModel):
    data: PermitCardApproved | PermitCardRejected
    permit_id: str
    meta: None = None
    error: None = None


class PermitListEnvelope(BaseModel):
    data: list[dict[str, Any]]
    meta: dict[str, Any]
    error: None = None


@router.post(
    "/",
    response_model=PermitIssuedEnvelope,
    status_code=status.HTTP_201_CREATED,
    summary="Request a Trade Permit for a trade ticket",
)
async def create_permit_endpoint(
    payload: PermitRequestBody,
    db: DbSession,
    user_id: CurrentUserId,
) -> PermitIssuedEnvelope:
    """Issue a Trade Permit (APPROVED or REJECTED) for the submitted trade ticket.

    Every call persists the permit — approved and rejected alike (EDR 0020
    decision 6).  The confirm control in the UI must only go live on an
    APPROVED, unexpired permit.

    Account state is fetched server-side from Binance/internal state. Client
    supplied account-state fields are not part of this schema and are ignored.
    """
    card, permit_id = await request_permit(
        db=db,
        user_id=user_id,
        ticket=payload.proposal,
    )
    return PermitIssuedEnvelope(data=card, permit_id=permit_id)


@router.get(
    "/{permit_id}",
    response_model=dict[str, Any],
    summary="Fetch a persisted Trade Permit by id",
)
async def get_permit_endpoint(
    permit_id: str,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict[str, Any]:
    """Return the raw persisted permit record by id (for audit / CRO narration)."""
    permit = await get_permit(db, permit_id)
    if permit.user_id != user_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return {
        "data": {
            "id": permit.id,
            "user_id": permit.user_id,
            "symbol": permit.symbol,
            "side": permit.side,
            "status": permit.status,
            "reasons": permit.reasons,
            "quality_score": permit.quality_score,
            "quality_components": permit.quality_components,
            "quality_disclaimer": permit.quality_disclaimer,
            "check_results": permit.check_results,
            "proposal_snapshot": permit.proposal_snapshot,
            "account_state_snapshot": permit.account_state_snapshot,
            "evaluated_at": permit.evaluated_at.isoformat(),
            "expires_at": permit.expires_at.isoformat(),
            "session": permit.session,
            "created_at": permit.created_at.isoformat(),
        },
        "meta": None,
        "error": None,
    }


@router.get(
    "/",
    response_model=PermitListEnvelope,
    summary="List Trade Permits for the current user, newest first",
)
async def list_permits_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
) -> PermitListEnvelope:
    permits, total = await list_permits(db, user_id, page=page, per_page=per_page)
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return PermitListEnvelope(
        data=[
            {
                "id": p.id,
                "symbol": p.symbol,
                "side": p.side,
                "status": p.status,
                "quality_score": p.quality_score,
                "reasons": p.reasons,
                "evaluated_at": p.evaluated_at.isoformat(),
                "expires_at": p.expires_at.isoformat(),
                "session": p.session,
                "created_at": p.created_at.isoformat(),
            }
            for p in permits
        ],
        meta=meta.model_dump(),
    )
