from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db

from .schemas import (
    ReaccumulationEvaluateEnvelope,
    ReaccumulationEvaluateRequest,
    ReaccumulationEventResponse,
    ReaccumulationListEnvelope,
    ReaccumulationReadResponse,
)
from .service import evaluate_reaccumulation_live, list_recent_reaccumulations

router = APIRouter(prefix="/patterns", tags=["patterns"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.get(
    "/reaccumulation",
    response_model=ReaccumulationListEnvelope,
    summary="Recent persisted REACCUMULATION / SECOND EXPANSION detections",
)
async def get_recent_reaccumulations(
    db: DbSession,
    limit: int = Query(20, ge=1, le=100),
    symbol: str | None = Query(None),
) -> ReaccumulationListEnvelope:
    rows = await list_recent_reaccumulations(db, symbol=symbol, limit=limit)
    return ReaccumulationListEnvelope(
        data=[ReaccumulationEventResponse.model_validate(r, from_attributes=True) for r in rows],
        meta={"count": len(rows)},
    )


@router.post(
    "/reaccumulation/evaluate",
    response_model=ReaccumulationEvaluateEnvelope,
    summary="Evaluate REACCUMULATION / SECOND EXPANSION live for one symbol",
)
async def post_evaluate_reaccumulation(
    payload: ReaccumulationEvaluateRequest,
) -> ReaccumulationEvaluateEnvelope:
    read = await evaluate_reaccumulation_live(payload.symbol)
    if read is None:
        return ReaccumulationEvaluateEnvelope(data=None)
    return ReaccumulationEvaluateEnvelope(
        data=ReaccumulationReadResponse(
            pattern=read.pattern,
            state=read.state,
            score=read.score,
            direction=read.direction,
            evidence=read.evidence,
            explanation=read.explanation,
            evaluated_at=read.evaluated_at,
            oi_available=read.oi_available,
            version=read.version,
            impulse_start_time=read.impulse_start_time,
            impulse_end_time=read.impulse_end_time,
            impulse_magnitude_pct=read.impulse_magnitude_pct,
            retracement_time=read.retracement_time,
            retracement_fraction=read.retracement_fraction,
            base_start_time=read.base_start_time,
            base_end_time=read.base_end_time,
            base_high=read.base_high,
            base_low=read.base_low,
            breakout_pct=read.breakout_pct,
        )
    )
