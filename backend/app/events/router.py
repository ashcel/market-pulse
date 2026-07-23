"""Events read API — the Python-plane counterpart of the legacy TS routes
(`/api/token-events`, `/api/economic-events`, the external-context catalyst
sections), with the Catalyst Impact Score stamped onto every row at serve
time. Additive surface: the legacy TS routes are untouched and keep serving
their existing shapes; consumers migrate here to gain `impact` / `direction`
/ `impact_version` (plan.md "Serve" + "Now" steps).

Public like its TS counterparts: news/calendar-plane data with no user
content. Read-only — the arq worker remains the sole writer.
"""

import re
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db

from . import service
from .impact import IMPACT_SCORE_VERSION
from .schemas import (
    CatalystEventListEnvelope,
    EconomicEventListEnvelope,
    TokenEventListEnvelope,
)

router = APIRouter(prefix="/events", tags=["events"])

DbSession = Annotated[AsyncSession, Depends(get_db)]

_SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,12}$")
# Same batch cap as the TS route (the discovery scanner's badge fan-out).
_BATCH_MAX_SYMBOLS = 16
_TOKEN_EVENT_WINDOW_DAYS = 7
# Unlocks cluster monthly; mirror the ingest horizon rather than a 7d window.
_CATALYST_MAX_DAYS = 60
_CATALYST_DEFAULT_DAYS = 45
_ECON_MAX_DAYS = 30
_ECON_DEFAULT_DAYS = 7
_ECON_TIERS = {"high", "medium", "low", "holiday"}


def _clean_symbol(raw: str) -> str:
    symbol = raw.strip().upper()
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=400, detail=f"invalid symbol '{raw}'")
    return symbol


def _meta(count: int, **extra: object) -> dict[str, object]:
    return {"count": count, "impact_version": IMPACT_SCORE_VERSION, **extra}


@router.get(
    "/token-events",
    response_model=TokenEventListEnvelope,
    summary="News-derived token events with serve-time impact scores",
)
async def get_token_events(
    db: DbSession,
    symbol: str | None = Query(None, description="One token's recent events"),
    symbols: str | None = Query(None, description="Comma-separated batch, last 7 days"),
    limit: int = Query(20, ge=1, le=50),
) -> TokenEventListEnvelope:
    if symbols is not None:
        batch = list(dict.fromkeys(_clean_symbol(s) for s in symbols.split(",") if s.strip()))
        batch = batch[:_BATCH_MAX_SYMBOLS]
        since = datetime.now(UTC) - timedelta(days=_TOKEN_EVENT_WINDOW_DAYS)
        events = await service.list_token_events_for_symbols(db, batch, since)
        return TokenEventListEnvelope(data=events, meta=_meta(len(events), symbols=batch))
    if symbol is None:
        raise HTTPException(status_code=400, detail="missing symbol")
    events = await service.list_token_events(db, _clean_symbol(symbol), limit=limit)
    return TokenEventListEnvelope(data=events, meta=_meta(len(events)))


@router.get(
    "/catalysts",
    response_model=CatalystEventListEnvelope,
    summary="Upcoming calendar catalysts (unlocks…) with impact scores",
)
async def get_catalysts(
    db: DbSession,
    symbol: str | None = Query(
        None, description="One token's upcoming catalysts; omit for the market backdrop"
    ),
    days: int = Query(_CATALYST_DEFAULT_DAYS, ge=1, le=_CATALYST_MAX_DAYS),
    limit: int = Query(10, ge=1, le=50),
) -> CatalystEventListEnvelope:
    until = datetime.now(UTC) + timedelta(days=days)
    if symbol is None:
        events = await service.list_market_catalysts(db, until, limit=limit)
    else:
        events = await service.list_upcoming_catalysts(
            db, _clean_symbol(symbol), until, limit=limit
        )
    return CatalystEventListEnvelope(data=events, meta=_meta(len(events), window_days=days))


@router.get(
    "/economic",
    response_model=EconomicEventListEnvelope,
    summary="Upcoming macro calendar with impact scores",
)
async def get_economic_events(
    db: DbSession,
    days: int = Query(_ECON_DEFAULT_DAYS, ge=1, le=_ECON_MAX_DAYS),
    min_impact: str | None = Query(None, description="Feed-tier floor: high | medium | low"),
) -> EconomicEventListEnvelope:
    if min_impact is not None and min_impact not in _ECON_TIERS:
        raise HTTPException(status_code=400, detail=f"invalid min_impact '{min_impact}'")
    until = datetime.now(UTC) + timedelta(days=days)
    events = await service.list_economic_events(db, until, min_impact=min_impact)
    return EconomicEventListEnvelope(data=events, meta=_meta(len(events), window_days=days))
