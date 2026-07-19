"""Execute router — M9 (EDR 0020 decision 6 follow-on).

POST /execution/permits/{permit_id}/execute — execute an APPROVED Trade
Permit as a Binance futures order.

This router is a pure HTTP wrapper around the already-built
`order_service.place_execution_order`. It does not implement any
order-placement, sizing, or dedupe logic itself — all of that (kill-switch
gate, idempotency dedupe, permit consumption + snapshot validation, entry
+ SL/TP submission, reconciliation) lives in `order_service.py`. This file
only: loads the permit, reads the values to submit off the permit's own
`proposal_snapshot` (so the service's internal mismatch check against that
same snapshot always passes), calls the service, and maps its exceptions
to HTTP responses.
"""

from decimal import Decimal
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUserId
from app.database import get_db

from .exceptions import (
    DuplicateIdempotencyKeyError,
    ExecutionDisabledError,
    ExecutionInProgressError,
    ExecutionNotReadyError,
    PermitAlreadyUsedError,
    PermitExpiredError,
    PermitMismatchError,
    PermitNotFoundError,
    PermitRejectedError,
)
from .order_service import place_execution_order
from .permit_service import get_permit

router = APIRouter(prefix="/execution/permits", tags=["execution"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


class ExecutePermitBody(BaseModel):
    """Request body for executing a permit.

    ``idempotency_key`` lets a caller supply its own key (e.g. to correlate
    a UI confirm-tap with a retry); if omitted, a deterministic
    ``exec-{permit_id}`` key is derived so a double-tap on the same permit
    is idempotent — matching `place_execution_order`'s own
    dedupe-by-idempotency-key behavior.

    ``entry_type`` is *not* part of a Trade Permit's `proposal_snapshot` —
    permits are requested from price/stop/target inputs only (see
    `permit_request_schemas.PermitRequest`), with no order-type field to
    validate against. It's accepted here and defaults to ``LIMIT`` since
    every permit snapshot carries a specific `entry_price` (POI limit-plan
    style tickets, not market-chase entries).
    """

    idempotency_key: str | None = None
    entry_type: str = "LIMIT"


class ExecutionResultEnvelope(BaseModel):
    data: dict[str, Any]
    permit_id: str
    meta: None = None
    error: None = None


def _order_side(snapshot_side: str) -> str:
    """LONG/SHORT (the permit snapshot's side) -> BUY/SELL (the order side).

    Mirrors `order_service._order_side` exactly. Duplicated locally rather
    than imported since that helper is private to `order_service` — this
    file must not edit or reach into that module's internals.
    """
    return "BUY" if snapshot_side.lower() == "long" else "SELL"


def _snapshot_float(snapshot: dict[str, Any], key: str) -> float | None:
    raw = snapshot.get(key)
    if raw is None:
        return None
    return float(Decimal(str(raw)))


@router.post(
    "/{permit_id}/execute",
    response_model=ExecutionResultEnvelope,
    summary="Execute an approved Trade Permit as a Binance futures order",
)
async def execute_permit_endpoint(
    permit_id: str,
    db: DbSession,
    user_id: CurrentUserId,
    payload: ExecutePermitBody | None = None,
) -> ExecutionResultEnvelope:
    """Submit the entry + protective SL/TP orders for an APPROVED, unexpired,
    unconsumed Trade Permit.

    The kill switch (`execution_settings.ENABLED`, default off) and every
    other readiness/permit check still lives inside `order_service` — this
    endpoint never bypasses it, it only surfaces the resulting exception as
    a clean HTTP response.
    """
    body = payload or ExecutePermitBody()
    idempotency_key = body.idempotency_key or f"exec-{permit_id}"

    try:
        permit = await get_permit(db, permit_id)
    except PermitNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if permit.user_id != user_id:
        # Treat "not theirs" the same as "not found" — no permit-existence leak.
        raise HTTPException(
            status_code=404,
            detail=f"No trade permit found with id '{permit_id}'",
        )

    snapshot = permit.proposal_snapshot
    symbol = str(snapshot["symbol"]).upper()
    side = _order_side(str(snapshot["side"]))
    entry_price = _snapshot_float(snapshot, "entry_price") or 0.0
    stop_price = _snapshot_float(snapshot, "stop_price") or 0.0
    target_price = _snapshot_float(snapshot, "take_profit_price") or 0.0
    leverage = _snapshot_float(snapshot, "leverage")
    risk_percent = _snapshot_float(snapshot, "risk_percent")

    try:
        response = await place_execution_order(
            db,
            user_id,
            permit_id,
            symbol,
            side,
            body.entry_type,
            entry_price,
            stop_price,
            target_price,
            0.0,  # quantity — re-derived from the permit snapshot internally, ignored
            idempotency_key,
            leverage=leverage,
            risk_percent=risk_percent,
        )
    except ExecutionDisabledError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "execution_disabled", "message": str(exc)},
        ) from exc
    except ExecutionNotReadyError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "execution_not_ready",
                "message": str(exc),
                "reasons": (exc.details or {}).get("reasons", []),
            },
        ) from exc
    except PermitNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermitRejectedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PermitExpiredError as exc:
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    except (PermitAlreadyUsedError, DuplicateIdempotencyKeyError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutionInProgressError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PermitMismatchError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "permit_mismatch",
                "message": str(exc),
                "fields": (exc.details or {}).get("fields", []),
            },
        ) from exc
    except httpx.HTTPStatusError as exc:
        # Exchange rejected the order request
        exchange_error_code = None
        exchange_error_msg = None

        try:
            error_json = exc.response.json()
            exchange_error_code = error_json.get("code")
            exchange_error_msg = error_json.get("msg")
        except (ValueError, KeyError, AttributeError):
            # Response wasn't valid JSON or didn't have expected fields
            exchange_error_msg = exc.response.text or str(exc)

        raise HTTPException(
            status_code=502,
            detail={
                "code": "exchange_rejected",
                "exchange_code": exchange_error_code,
                "message": exchange_error_msg,
            },
        ) from exc
    except httpx.RequestError as exc:
        # Network error or timeout communicating with exchange
        raise HTTPException(
            status_code=504,
            detail={
                "code": "exchange_unreachable",
                "message": str(exc),
            },
        ) from exc

    return ExecutionResultEnvelope(data=response, permit_id=permit_id)
