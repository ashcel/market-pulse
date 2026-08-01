"""Quant signals proxy.

The quant-notifier dashboard (localhost:8787) already computes regime, the
signal feed, money flow, events, news and the per-token forecast. Duplicating
that logic here would fork two sources of truth for the same numbers, so this
router only forwards.

Two gates sit in front of it, deliberately:
  1. the normal Market Pulse session (CurrentUserId) — nobody unauthenticated
     reaches the upstream at all;
  2. the caller's own `x-telegram-init-data`, copied verbatim onto the upstream
     request, because the dashboard authenticates on that header itself. The
     header is never stored — it lives for the duration of the request.
"""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse

from app.auth.dependencies import CurrentUserId, DbSession
from app.config import settings
from app.signals.models import SignalEvent
from app.signals.repo import list_signals

router = APIRouter(prefix="/quant", tags=["quant"])

QUANT_BASE_URL = "http://localhost:8787"
UPSTREAM_TIMEOUT_S = 15.0

# Sprint 2 "balik arah" (docs/IMPLEMENTATION-PLAN.md §3 task 5) — the flip is
# deliberately PARTIAL. When True, only the `signals` feed of /quant/state is
# served from our own `signal_events`; regime, money flow, events and news, and
# all of /quant/token (the forecast cone) keep proxying, because the forecast
# engine still lives in notifier-bot/src/forecast and porting it is Sprint 5
# work, not a 3-day detour.
#
# Default False = byte-identical behaviour to before this sprint. This one
# constant is the whole rollback (plan §1 rule 3).
FEED_FROM_DB = False


async def _fetch(path: str, params: dict[str, Any], init_data: str | None) -> tuple[int, Any]:
    headers = {"accept": "application/json"}
    if init_data:
        headers["x-telegram-init-data"] = init_data
    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S) as client:
            res = await client.get(f"{QUANT_BASE_URL}{path}", params=params, headers=headers)
    except httpx.HTTPError as exc:
        return 502, {"error": "quant dashboard unavailable", "detail": str(exc)}
    try:
        body = res.json()
    except ValueError:
        return 502, {"error": "quant dashboard returned a non-JSON response"}
    # Pass the upstream status through — a 401 from the dashboard means the
    # initData did not satisfy *it*, which the client must be able to see.
    return res.status_code, body


async def _forward(path: str, params: dict[str, Any], init_data: str | None) -> JSONResponse:
    status, body = await _fetch(path, params, init_data)
    return JSONResponse(status_code=status, content=body)


def _feed_row(event: SignalEvent) -> dict[str, Any]:
    """Rebuild one dashboard feed row from an owned fact.

    `features` is the source's payload stored verbatim, so it already carries
    the feed shape; the table columns only fill in what the payload lacks.
    Preferring the payload keeps the served feed byte-faithful to what the
    detector wrote (e.g. conviction 'very-high', which the column normalises to
    'very_high') — the DB feed must not silently differ from the proxied one
    during the 48h reconciliation.
    """
    row = dict(event.features or {})
    detected_at = event.detected_at
    if detected_at.tzinfo is None:
        detected_at = detected_at.replace(tzinfo=UTC)
    row.setdefault("at", detected_at.isoformat().replace("+00:00", "Z"))
    row.setdefault("symbol", event.symbol)
    row.setdefault("kind", event.kind)
    row.setdefault("direction", event.side)
    row.setdefault("conviction", event.conviction)
    return row


async def _db_feed(db: DbSession, days: int) -> tuple[list[dict[str, Any]], dict[str, int]]:
    events = await list_signals(
        db,
        since=datetime.now(UTC) - timedelta(days=days),
        sources=list(settings.SIGNAL_SOURCES_LIVE) or None,
    )
    rows = [_feed_row(event) for event in events]  # newest first, as upstream
    notified = sum(1 for row in rows if row.get("notified"))
    return rows, {"total": len(rows), "notified": notified, "silent": len(rows) - notified}


@router.get("/state", summary="Regime + signal feed + flow + events + news")
async def quant_state(
    db: DbSession,
    _user_id: CurrentUserId,
    days: Annotated[int, Query(ge=1, le=90)] = 14,
    x_telegram_init_data: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    status, body = await _fetch("/api/state", {"days": days}, x_telegram_init_data)
    if not FEED_FROM_DB or status != 200 or not isinstance(body, dict):
        return JSONResponse(status_code=status, content=body)

    rows, counts = await _db_feed(db, days)
    body["signals"] = rows
    summary = body.get("summary")
    if isinstance(summary, dict):
        summary.update(counts)
    # Provenance: a reader must be able to tell which plane answered.
    body["signalsSource"] = "market_pulse"
    return JSONResponse(status_code=200, content=body)


@router.get("/token", summary="Token candles + forecast + per-token signals")
async def quant_token(
    _user_id: CurrentUserId,
    symbol: Annotated[str, Query(min_length=1, max_length=24)],
    x_telegram_init_data: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    return await _forward("/api/token", {"symbol": symbol.upper()}, x_telegram_init_data)
