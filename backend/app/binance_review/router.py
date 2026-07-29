from fastapi import APIRouter, Query, status

from app.auth.dependencies import CurrentUserId, DbSession
from app.pagination import PaginationMeta

from .consolidated import list_trades_consolidated_paginated
from .schemas import (
    BinanceReviewKeyCreate,
    BinanceReviewKeyEnvelope,
    BinanceReviewKeyResponse,
    BinanceReviewSyncLogEnvelope,
    BinanceReviewSyncLogResponse,
    BinanceTradeListEnvelope,
    BinanceTradeResponse,
)
from .service import (
    delete_key,
    get_key,
    get_sync_log,
    list_trades,
    mask_api_key,
    run_sync,
    save_key,
)

router = APIRouter(prefix="/binance-review", tags=["binance-review"])


def _masked_response(key: object) -> BinanceReviewKeyEnvelope:
    response = BinanceReviewKeyResponse.model_validate(key)
    response.api_key = mask_api_key(response.api_key)
    return BinanceReviewKeyEnvelope(data=response)


@router.post(
    "/api-key",
    response_model=BinanceReviewKeyEnvelope,
    status_code=status.HTTP_201_CREATED,
    summary="Save (or replace) the user's read-only Binance API key for Trade Review",
)
async def create_api_key(
    payload: BinanceReviewKeyCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> BinanceReviewKeyEnvelope:
    key = await save_key(db, user_id, payload)
    return _masked_response(key)


@router.get(
    "/api-key",
    response_model=BinanceReviewKeyEnvelope,
    summary="Get the user's saved Binance API key (masked)",
)
async def get_api_key_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
) -> BinanceReviewKeyEnvelope:
    key = await get_key(db, user_id)
    return _masked_response(key)


@router.delete(
    "/api-key",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete the user's saved Binance API key",
)
async def delete_api_key_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    await delete_key(db, user_id)


@router.post(
    "/sync",
    response_model=BinanceReviewSyncLogEnvelope,
    summary="Sync realized PnL + enrich trades from Binance USDT-M futures",
)
async def sync_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
) -> BinanceReviewSyncLogEnvelope:
    log = await run_sync(db, user_id)
    return BinanceReviewSyncLogEnvelope(data=BinanceReviewSyncLogResponse.model_validate(log))


@router.get(
    "/sync/{sync_id}",
    response_model=BinanceReviewSyncLogEnvelope,
    summary="Get a sync log's status",
)
async def get_sync_log_endpoint(
    sync_id: str,
    db: DbSession,
    user_id: CurrentUserId,
) -> BinanceReviewSyncLogEnvelope:
    log = await get_sync_log(db, sync_id, user_id)
    return BinanceReviewSyncLogEnvelope(data=BinanceReviewSyncLogResponse.model_validate(log))


@router.get(
    "/trades",
    response_model=BinanceTradeListEnvelope,
    summary="List the user's synced Binance trades",
)
async def get_trades(
    db: DbSession,
    user_id: CurrentUserId,
    symbol: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    consolidated: bool = Query(
        False,
        description="When true, group partial fills by (symbol, side, second) into logical trades",
    ),
) -> BinanceTradeListEnvelope:
    if consolidated:
        data, _, meta = await list_trades_consolidated_paginated(
            db, user_id=user_id, symbol=symbol, page=page, per_page=per_page,
        )
        return BinanceTradeListEnvelope(
            data=data,
            meta=meta.model_dump(),
            error=None,
        )
    trades, total = await list_trades(
        db, user_id=user_id, symbol=symbol, page=page, per_page=per_page
    )
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return BinanceTradeListEnvelope(
        data=[BinanceTradeResponse.model_validate(t) for t in trades],
        meta=meta.model_dump(),
        error=None,
    )