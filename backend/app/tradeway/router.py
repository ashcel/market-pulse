"""Tradeway (Bybit positions) proxy.

The tradeway-api service on localhost:8100 is not built yet, so the *normal*
state of this router is "upstream refused the connection". That is a 503 with
a readable body, never an exception the UI has to guess at — the positions tab
renders an offline state from it.
"""

from typing import Any

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.auth.dependencies import CurrentUserId

router = APIRouter(prefix="/tradeway", tags=["tradeway"])

TRADEWAY_BASE_URL = "http://localhost:8100"
UPSTREAM_TIMEOUT_S = 5.0


async def _forward(path: str) -> JSONResponse:
    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S) as client:
            res = await client.get(f"{TRADEWAY_BASE_URL}{path}")
    except httpx.HTTPError as exc:
        return JSONResponse(
            status_code=503,
            content={"error": "tradeway-api unavailable", "detail": str(exc)},
        )
    body: Any
    try:
        body = res.json()
    except ValueError:
        return JSONResponse(
            status_code=503,
            content={"error": "tradeway-api unavailable", "detail": "non-JSON response"},
        )
    return JSONResponse(status_code=res.status_code, content=body)


@router.get("/positions", summary="Open Bybit positions from tradeway-api")
async def tradeway_positions(_user_id: CurrentUserId) -> JSONResponse:
    return await _forward("/positions")


@router.get("/healthz", summary="tradeway-api liveness passthrough")
async def tradeway_healthz(_user_id: CurrentUserId) -> JSONResponse:
    return await _forward("/healthz")
