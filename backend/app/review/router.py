from datetime import datetime

from fastapi import APIRouter, Query, status

from app.auth.dependencies import CurrentUserId, DbSession
from app.pagination import PaginationMeta

from .forensics_service import get_forensics, list_forensics
from .schemas import (
    AnalyticsResponse,
    TradeForensicsEnvelope,
    TradeForensicsListEnvelope,
    TradeForensicsResponse,
    TradeReviewCreate,
    TradeReviewEnvelope,
    TradeReviewResponse,
)
from .service import get_analytics, get_review, save_review

router = APIRouter(prefix="/review", tags=["review"])


@router.get(
    "/analytics",
    response_model=AnalyticsResponse,
    summary="RR, best/worst, best hour range, session split, and style suitability",
)
async def get_analytics_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
    symbol: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
) -> AnalyticsResponse:
    data = await get_analytics(db, user_id, symbol=symbol, start=start, end=end)
    return AnalyticsResponse(data=data)


@router.get("/forensics", response_model=TradeForensicsListEnvelope)
async def list_forensics_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
) -> TradeForensicsListEnvelope:
    rows, total = await list_forensics(db, user_id, page, per_page)
    return TradeForensicsListEnvelope(
        data=[TradeForensicsResponse.model_validate(row) for row in rows],
        meta=PaginationMeta(page=page, per_page=per_page, total=total).model_dump(),
    )


@router.get("/forensics/{trade_id}", response_model=TradeForensicsEnvelope)
async def get_forensics_endpoint(
    trade_id: str, db: DbSession, user_id: CurrentUserId
) -> TradeForensicsEnvelope:
    row = await get_forensics(db, user_id, trade_id)
    return TradeForensicsEnvelope(data=TradeForensicsResponse.model_validate(row))


@router.post(
    "/{binance_trade_id}",
    response_model=TradeReviewEnvelope,
    status_code=status.HTTP_201_CREATED,
    summary="Persist a client-generated trade review verbatim",
)
async def save_review_endpoint(
    binance_trade_id: str,
    payload: TradeReviewCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> TradeReviewEnvelope:
    review = await save_review(db, user_id, binance_trade_id, payload)
    return TradeReviewEnvelope(data=TradeReviewResponse.model_validate(review))


@router.get(
    "/{binance_trade_id}",
    response_model=TradeReviewEnvelope,
    summary="Get the latest review for a trade",
)
async def get_review_endpoint(
    binance_trade_id: str,
    db: DbSession,
    user_id: CurrentUserId,
) -> TradeReviewEnvelope:
    review = await get_review(db, user_id, binance_trade_id)
    return TradeReviewEnvelope(data=TradeReviewResponse.model_validate(review))
