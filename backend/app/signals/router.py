"""Read-only signal facts for the Ticket page."""

from datetime import UTC, datetime, timedelta
from typing import Any, Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict

from app.auth.dependencies import CurrentUserId, DbSession

from .repo import list_signals

router = APIRouter(prefix="/signals", tags=["signals"])


class SignalResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    source: str
    source_version: str
    symbol: str
    side: str
    horizon: str
    kind: str
    conviction: str | None
    detected_at: datetime
    expires_at: datetime | None
    features: dict[str, Any]


@router.get("", summary="Recent signal facts for one Ticket")
async def get_signals(
    db: DbSession,
    _user_id: CurrentUserId,
    symbol: Annotated[str | None, Query(max_length=20)] = None,
    horizon: Annotated[str | None, Query(max_length=16)] = None,
    lookback_days: Annotated[int, Query(ge=1, le=30)] = 7,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, Any]:
    rows = await list_signals(
        db,
        symbol=symbol,
        horizon=horizon,
        since=datetime.now(UTC) - timedelta(days=lookback_days),
        limit=limit,
    )
    return {
        "data": [SignalResponse.model_validate(row).model_dump(mode="json") for row in rows],
        "meta": {"count": len(rows)},
        "error": None,
    }
