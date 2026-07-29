from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.pagination import PaginationMeta

from .exceptions import SignalNotFoundError, TokenNotFoundError
from .models import Signal
from .schemas import (
    SignalDetailEnvelope,
    SignalListEnvelope,
    SignalResponse,
    TokenDetailEnvelope,
    TokenListEnvelope,
    TokenResponse,
)
from .service import get_latest_signals, get_token_by_symbol, list_signals, list_tokens

router = APIRouter(prefix="/market", tags=["market"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.get(
    "/tokens",
    response_model=TokenListEnvelope,
    summary="List all tracked tokens",
)
async def get_tokens(
    db: DbSession,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
) -> TokenListEnvelope:
    tokens, total = await list_tokens(db, page=page, per_page=per_page)
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return TokenListEnvelope(
        data=[TokenResponse.model_validate(t) for t in tokens],
        meta=meta.model_dump(),
    )


@router.get(
    "/tokens/{symbol}",
    response_model=TokenDetailEnvelope,
    summary="Get token detail by symbol",
)
async def get_token(
    symbol: str,
    db: DbSession,
) -> TokenDetailEnvelope:
    token = await get_token_by_symbol(db, symbol)
    if not token:
        raise TokenNotFoundError(symbol)
    return TokenDetailEnvelope(data=TokenResponse.model_validate(token))


@router.get(
    "/signals/latest",
    response_model=SignalListEnvelope,
    summary="Get latest signals",
)
async def get_latest(
    db: DbSession,
    limit: int = Query(10, ge=1, le=50),
) -> SignalListEnvelope:
    signals = await get_latest_signals(db, limit=limit)
    return SignalListEnvelope(
        data=[SignalResponse.model_validate(s) for s in signals],
        meta={"count": len(signals)},
    )


@router.get(
    "/signals",
    response_model=SignalListEnvelope,
    summary="List signals with optional filters",
)
async def get_signals(
    db: DbSession,
    token_id: str | None = Query(None),
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
) -> SignalListEnvelope:
    signals, total = await list_signals(
        db, token_id=token_id, status=status, page=page, per_page=per_page
    )
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return SignalListEnvelope(
        data=[SignalResponse.model_validate(s) for s in signals],
        meta=meta.model_dump(),
    )


@router.get(
    "/signals/{signal_id}",
    response_model=SignalDetailEnvelope,
    summary="Get signal detail by ID",
)
async def get_signal(
    signal_id: str,
    db: DbSession,
) -> SignalDetailEnvelope:
    result = await db.execute(select(Signal).where(Signal.id == signal_id))
    signal = result.scalar_one_or_none()
    if not signal:
        raise SignalNotFoundError(signal_id)
    return SignalDetailEnvelope(data=SignalResponse.model_validate(signal))
