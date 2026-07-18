from fastapi import APIRouter, Query, status

from app.auth.dependencies import CurrentUserId, DbSession
from app.pagination import PaginationMeta

from .schemas import (
    BybitApiKeyCreate,
    BybitApiKeyEnvelope,
    BybitApiKeyResponse,
    BybitSyncLogEnvelope,
    BybitSyncLogResponse,
    BybitTradeListEnvelope,
    BybitTradeResponse,
)
from .service import (
    delete_api_key,
    get_api_key,
    get_sync_log,
    list_trades,
    mask_api_key,
    run_sync,
    save_api_key,
)

router = APIRouter(prefix="/bybit", tags=["bybit"])


def _masked_response(key: object) -> BybitApiKeyEnvelope:
    response = BybitApiKeyResponse.model_validate(key)
    response.api_key = mask_api_key(response.api_key)
    return BybitApiKeyEnvelope(data=response)


@router.post(
    "/api-key",
    response_model=BybitApiKeyEnvelope,
    status_code=status.HTTP_201_CREATED,
    summary="Save (or replace) the user's Bybit API key",
)
async def create_api_key(
    payload: BybitApiKeyCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> BybitApiKeyEnvelope:
    key = await save_api_key(db, user_id, payload)
    return _masked_response(key)


@router.get(
    "/api-key",
    response_model=BybitApiKeyEnvelope,
    summary="Get the user's saved Bybit API key (masked)",
)
async def get_api_key_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
) -> BybitApiKeyEnvelope:
    key = await get_api_key(db, user_id)
    return _masked_response(key)


@router.delete(
    "/api-key",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete the user's saved Bybit API key",
)
async def delete_api_key_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    await delete_api_key(db, user_id)


@router.post(
    "/sync",
    response_model=BybitSyncLogEnvelope,
    summary="Sync closed PnL + enrich trades from Bybit",
)
async def sync_endpoint(
    db: DbSession,
    user_id: CurrentUserId,
) -> BybitSyncLogEnvelope:
    log = await run_sync(db, user_id)
    return BybitSyncLogEnvelope(data=BybitSyncLogResponse.model_validate(log))


@router.get(
    "/sync/{sync_id}",
    response_model=BybitSyncLogEnvelope,
    summary="Get a sync log's status",
)
async def get_sync_log_endpoint(
    sync_id: str,
    db: DbSession,
    user_id: CurrentUserId,
) -> BybitSyncLogEnvelope:
    log = await get_sync_log(db, sync_id, user_id)
    return BybitSyncLogEnvelope(data=BybitSyncLogResponse.model_validate(log))


@router.get(
    "/trades",
    response_model=BybitTradeListEnvelope,
    summary="List the user's synced Bybit trades",
)
async def get_trades(
    db: DbSession,
    user_id: CurrentUserId,
    symbol: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
) -> BybitTradeListEnvelope:
    trades, total = await list_trades(
        db, user_id=user_id, symbol=symbol, page=page, per_page=per_page
    )
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return BybitTradeListEnvelope(
        data=[BybitTradeResponse.model_validate(t) for t in trades],
        meta=meta.model_dump(),
    )
