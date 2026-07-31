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

from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse

from app.auth.dependencies import CurrentUserId

router = APIRouter(prefix="/quant", tags=["quant"])

QUANT_BASE_URL = "http://localhost:8787"
UPSTREAM_TIMEOUT_S = 15.0


async def _forward(path: str, params: dict[str, Any], init_data: str | None) -> JSONResponse:
    headers = {"accept": "application/json"}
    if init_data:
        headers["x-telegram-init-data"] = init_data
    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S) as client:
            res = await client.get(f"{QUANT_BASE_URL}{path}", params=params, headers=headers)
    except httpx.HTTPError as exc:
        return JSONResponse(
            status_code=502,
            content={"error": "quant dashboard unavailable", "detail": str(exc)},
        )
    try:
        body = res.json()
    except ValueError:
        return JSONResponse(
            status_code=502,
            content={"error": "quant dashboard returned a non-JSON response"},
        )
    # Pass the upstream status through — a 401 from the dashboard means the
    # initData did not satisfy *it*, which the client must be able to see.
    return JSONResponse(status_code=res.status_code, content=body)


@router.get("/state", summary="Regime + signal feed + flow + events + news")
async def quant_state(
    _user_id: CurrentUserId,
    days: Annotated[int, Query(ge=1, le=90)] = 14,
    x_telegram_init_data: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    return await _forward("/api/state", {"days": days}, x_telegram_init_data)


@router.get("/token", summary="Token candles + forecast + per-token signals")
async def quant_token(
    _user_id: CurrentUserId,
    symbol: Annotated[str, Query(min_length=1, max_length=24)],
    x_telegram_init_data: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    return await _forward("/api/token", {"symbol": symbol.upper()}, x_telegram_init_data)
