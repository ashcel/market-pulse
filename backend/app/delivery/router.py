"""Ingest endpoint — Sprint 1 "satu mulut" (docs/IMPLEMENTATION-PLAN.md §3 task
5). External writers (notifier-bot) POST here instead of sending Telegram
messages themselves, so every alert Dee receives — regardless of origin —
flows through the one delivery pass and the one platform bot.

Auth reuses the existing internal-key bridge (`X-Internal-Key` +
`X-Internal-User-Id`, see `app/auth/dependencies.py`) — no new auth surface.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from app.auth.dependencies import CurrentUserId, DbSession
from app.execution.alert_models import AlertSeverity, AlertType
from app.execution.alert_service import AlertCandidate, create_alerts

router = APIRouter(prefix="/alerts", tags=["alerts"])


class AlertIngest(BaseModel):
    type: AlertType
    token_symbol: str
    title: str
    body: str
    severity: AlertSeverity
    dedupe_key: str
    source: str = "market_pulse"
    # Lets a dual-run shadow source ingest without ever being sent
    # (delivery_state='suppressed') — the count-reconciliation path in the
    # Sprint 1 exit criteria depends on this.
    delivery_state: str | None = None


@router.post("/ingest")
async def ingest_alert(payload: AlertIngest, db: DbSession, user_id: CurrentUserId) -> dict:
    candidate = AlertCandidate(
        user_id=user_id,
        type=payload.type,
        token_symbol=payload.token_symbol,
        title=payload.title,
        body=payload.body,
        severity=payload.severity,
        dedupe_key=payload.dedupe_key,
        source=payload.source,
        delivery_state=payload.delivery_state or "pending",
    )
    inserted = await create_alerts(db, [candidate])
    return {"data": {"inserted": inserted > 0}, "meta": None, "error": None}
