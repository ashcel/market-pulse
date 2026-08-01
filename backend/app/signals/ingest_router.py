"""Signal ingest — Sprint 2 "balik arah" (docs/IMPLEMENTATION-PLAN.md §3 task
2). External detectors (notifier-bot today; the SMC engine and tradeway later)
POST their facts here, and Market Pulse stops being a window into another app's
memory.

Auth reuses the existing internal-key bridge (`X-Internal-Key` +
`X-Internal-User-Id`, `app/auth/dependencies.py`) — no new auth surface. The
user id is not stored: a signal is a fact about the market, not about a user;
the header only proves the caller is trusted.
"""

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.auth.dependencies import CurrentUserId, DbSession

from .repo import insert_signal

router = APIRouter(prefix="/ingest", tags=["signals"])


class SignalIngest(BaseModel):
    source: str = Field(max_length=32)
    source_version: str = Field(max_length=32)
    symbol: str = Field(max_length=20)
    side: str = Field(max_length=8)
    horizon: str = Field(max_length=16)
    kind: str = Field(max_length=48)
    conviction: str | None = Field(default=None, max_length=16)
    detected_at: datetime
    expires_at: datetime | None = None
    features: dict[str, Any] = Field(default_factory=dict)
    dedup_key: str = Field(max_length=255)
    # Writers may supply their own uuid so a retry after a network timeout is
    # byte-identical; dedup_key is the real idempotency key either way.
    id: str | None = Field(default=None, max_length=36)


@router.post("/signal", summary="Append one signal fact (idempotent)")
async def ingest_signal(
    payload: SignalIngest, db: DbSession, _user_id: CurrentUserId
) -> dict[str, Any]:
    inserted = await insert_signal(
        db,
        id=payload.id or str(uuid.uuid4()),
        source=payload.source,
        source_version=payload.source_version,
        symbol=payload.symbol.upper(),
        side=payload.side,
        horizon=payload.horizon,
        kind=payload.kind,
        conviction=payload.conviction,
        detected_at=payload.detected_at,
        expires_at=payload.expires_at,
        features=payload.features,
        dedup_key=payload.dedup_key,
    )
    return {"data": {"inserted": inserted}, "meta": None, "error": None}
