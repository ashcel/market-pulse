"""New-listing screener API.

Public, like `/patterns` and `/market-context`: provider market data plus a
deterministic research read, no user content — so no session dependency and
no `X-Internal-*` headers.

    GET /listings                 → screener list (time-to-list, then score)
    GET /listings/{symbol}        → one listing, full detail
    GET /listings/{symbol}/brief  → the deterministic evidence pack for the AI layer
    GET /listings/alerts/recent   → recently dispatched Telegram alerts
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db

from .schemas import (
    AlertListEnvelope,
    ListingDetailEnvelope,
    ListingListEnvelope,
)
from .service import build_ai_brief, get_listing_detail, list_alerts, list_listings

router = APIRouter(prefix="/listings", tags=["listings"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.get(
    "",
    response_model=ListingListEnvelope,
    summary="New and upcoming Binance listings, screened",
)
async def get_listings(
    db: DbSession,
    limit: int = Query(60, ge=1, le=200),
    status: str | None = Query(
        None, pattern="^(UPCOMING|ALPHA|SPOT|FUTURES)$", description="Venue rung reached."
    ),
    grade: str | None = Query(None, pattern="^(PRIORITY|WATCH|THIN|SKIP)$"),
    min_score: float | None = Query(None, ge=0, le=100),
    sort: str = Query("time", pattern="^(time|score|change)$"),
    include_rejected: bool = Query(
        False, description="Include tokens the screener gated out (dust liquidity, dead feed)."
    ),
) -> ListingListEnvelope:
    data, meta = await list_listings(
        db,
        limit=limit,
        status=status,
        grade=grade,
        min_score=min_score,
        sort=sort,
        include_rejected=include_rejected,
    )
    return ListingListEnvelope(data=data, meta=meta)


@router.get(
    "/alerts/recent",
    response_model=AlertListEnvelope,
    summary="Recently dispatched followed-token alerts",
)
async def get_recent_alerts(
    db: DbSession,
    limit: int = Query(50, ge=1, le=200),
) -> AlertListEnvelope:
    rows = await list_alerts(db, limit=limit)
    return AlertListEnvelope(data=rows, meta={"count": len(rows)})


@router.get(
    "/{symbol}",
    response_model=ListingDetailEnvelope,
    summary="One listing, with holder map, social pulse and price-since-launch",
)
async def get_listing(db: DbSession, symbol: str) -> ListingDetailEnvelope:
    detail = await get_listing_detail(db, symbol)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"no listing record for {symbol.upper()}")
    return ListingDetailEnvelope(
        data=detail,
        meta={"score_version": detail.score_version, "scored_at": detail.scored_at},
    )


@router.get(
    "/{symbol}/brief",
    summary="Deterministic evidence pack for the AI analyst",
)
async def get_listing_brief(db: DbSession, symbol: str) -> dict:
    """Every number the AI layer is allowed to talk about.

    The model narrates this pack; it never fetches and never originates the
    score — the same boundary the CRO prompt holds elsewhere in the product.
    """
    detail = await get_listing_detail(db, symbol)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"no listing record for {symbol.upper()}")
    return {"data": build_ai_brief(detail), "meta": None, "error": None}
