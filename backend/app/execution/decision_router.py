from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from app.auth.dependencies import CurrentUserId, DbSession
from app.pagination import PaginationMeta

from .decision_service import create_decision, get_decision, list_decisions, record_decision_action
from .decision_snapshot import DecisionSnapshot

router = APIRouter(prefix="/decisions", tags=["decisions"])

Objective = Literal["scalp", "intraday", "swing", "position"]
Direction = Literal["long", "short"]
UserAction = Literal["accepted_skip", "rejected_skip", "took_trade", "ignored"]
SkipReason = Literal["invalid", "late", "no_conviction", "risk"]


class DecisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(min_length=1, max_length=20)
    objective: Objective
    direction: Direction
    verdict_at_time: str = Field(min_length=1, max_length=50)
    catalyst_modifier: dict[str, Any] | None = None
    skip_check_result: dict[str, Any] | None = None
    entry_zone: dict[str, Any] | None = None
    stop_loss: float | None = None
    take_profit: float | None = None
    engine_version: str = Field(min_length=1, max_length=50)


class DecisionActionPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_action: UserAction
    actual_outcome: dict[str, Any] | None = None
    skip_reason: SkipReason | None = None


class DecisionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    symbol: str
    objective: str
    direction: str
    verdict_at_time: str
    catalyst_modifier: dict[str, Any] | None
    skip_check_result: dict[str, Any] | None
    entry_zone: dict[str, Any] | None
    stop_loss: float | None
    take_profit: float | None
    user_action: str | None
    skip_reason: str | None
    actual_outcome: dict[str, Any] | None
    engine_version: str
    created_at: datetime
    decided_at: datetime | None


class DecisionEnvelope(BaseModel):
    data: DecisionResponse
    meta: None = None
    error: None = None


class DecisionListEnvelope(BaseModel):
    data: list[DecisionResponse]
    meta: dict[str, Any]
    error: None = None


async def _owned(db: DbSession, user_id: str, decision_id: str) -> DecisionSnapshot:
    decision = await get_decision(db, user_id, decision_id)
    if decision is None:
        raise HTTPException(status_code=404, detail="Decision not found")
    return decision


@router.post("", response_model=DecisionEnvelope, status_code=status.HTTP_201_CREATED)
async def create_decision_endpoint(
    payload: DecisionCreate, db: DbSession, user_id: CurrentUserId
) -> DecisionEnvelope:
    values = payload.model_dump()
    values["symbol"] = payload.symbol.upper()
    decision = await create_decision(db, user_id, values)
    return DecisionEnvelope(data=DecisionResponse.model_validate(decision))


@router.patch("/{decision_id}/action", response_model=DecisionEnvelope)
async def patch_decision_action_endpoint(
    decision_id: str, payload: DecisionActionPatch, db: DbSession, user_id: CurrentUserId
) -> DecisionEnvelope:
    if payload.skip_reason is not None and payload.user_action not in {"accepted_skip", "rejected_skip"}:
        raise HTTPException(status_code=422, detail="skip_reason requires a skip action")
    decision = await _owned(db, user_id, decision_id)
    updated = await record_decision_action(
        db, decision, payload.user_action, payload.actual_outcome, payload.skip_reason
    )
    return DecisionEnvelope(data=DecisionResponse.model_validate(updated))


@router.get("", response_model=DecisionListEnvelope)
async def list_decisions_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
    symbol: str | None = None,
    objective: Objective | None = None,
    user_action: UserAction | None = None,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
) -> DecisionListEnvelope:
    rows, total = await list_decisions(
        db,
        user_id,
        symbol=symbol,
        objective=objective,
        user_action=user_action,
        page=page,
        per_page=per_page,
    )
    return DecisionListEnvelope(
        data=[DecisionResponse.model_validate(row) for row in rows],
        meta=PaginationMeta(page=page, per_page=per_page, total=total).model_dump(),
    )


@router.get("/{decision_id}", response_model=DecisionEnvelope)
async def get_decision_endpoint(
    decision_id: str, db: DbSession, user_id: CurrentUserId
) -> DecisionEnvelope:
    decision = await _owned(db, user_id, decision_id)
    return DecisionEnvelope(data=DecisionResponse.model_validate(decision))
