from datetime import datetime

from fastapi import APIRouter, status

from app.auth.dependencies import CurrentUserId, DbSession

from .schemas import AnalyticsResponse, TradeReviewCreate, TradeReviewEnvelope, TradeReviewResponse
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
