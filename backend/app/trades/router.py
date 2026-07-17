from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUserId
from app.database import get_db
from app.pagination import PaginationMeta

from .schemas import (
    TradeCreate,
    TradeDetailEnvelope,
    TradeListEnvelope,
    TradeResponse,
    TradeUpdate,
)
from .service import create_trade, delete_trade, get_trade_by_id, list_trades, update_trade

router = APIRouter(prefix="/trades", tags=["trades"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.get(
    "/",
    response_model=TradeListEnvelope,
    summary="List user's trades",
)
async def get_trades(
    db: DbSession,
    user_id: CurrentUserId,
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
) -> TradeListEnvelope:
    trades, total = await list_trades(
        db, user_id=user_id, status=status, page=page, per_page=per_page
    )
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return TradeListEnvelope(
        data=[TradeResponse.model_validate(t) for t in trades],
        meta=meta.model_dump(),
    )


@router.get(
    "/{trade_id}",
    response_model=TradeDetailEnvelope,
    summary="Get trade detail",
)
async def get_trade(
    trade_id: str,
    db: DbSession,
    user_id: CurrentUserId,
) -> TradeDetailEnvelope:
    trade = await get_trade_by_id(db, trade_id, user_id)
    return TradeDetailEnvelope(data=TradeResponse.model_validate(trade))


@router.post(
    "/",
    response_model=TradeDetailEnvelope,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new trade",
)
async def create_trade_endpoint(
    payload: TradeCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> TradeDetailEnvelope:
    trade = await create_trade(db, user_id, payload)
    return TradeDetailEnvelope(data=TradeResponse.model_validate(trade))


@router.patch(
    "/{trade_id}",
    response_model=TradeDetailEnvelope,
    summary="Update a trade",
)
async def update_trade_endpoint(
    trade_id: str,
    payload: TradeUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> TradeDetailEnvelope:
    trade = await update_trade(db, trade_id, user_id, payload)
    return TradeDetailEnvelope(data=TradeResponse.model_validate(trade))


@router.delete(
    "/{trade_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a trade",
)
async def delete_trade_endpoint(
    trade_id: str,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    await delete_trade(db, trade_id, user_id)
