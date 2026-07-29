from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.auth.dependencies import CurrentUserId, DbSession

from .alert_service import list_alerts, mark_all_read, mark_read

router = APIRouter(prefix="/alerts", tags=["alerts"])


class AlertResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    type: str
    token_symbol: str
    title: str
    body: str
    severity: str
    read: bool
    created_at: datetime
    delivered_at: datetime | None
    source_decision_id: str | None


@router.get("")
async def get_alerts(
    db: DbSession,
    user_id: CurrentUserId,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    unread: bool | None = None,
) -> dict:
    rows, total = await list_alerts(db, user_id, page, per_page, unread)
    return {
        "data": [AlertResponse.model_validate(row) for row in rows],
        "meta": {"page": page, "per_page": per_page, "total": total},
        "error": None,
    }


@router.patch("/{alert_id}/read")
async def read_alert(alert_id: str, db: DbSession, user_id: CurrentUserId) -> dict:
    alert = await mark_read(db, user_id, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"data": AlertResponse.model_validate(alert), "meta": None, "error": None}


@router.post("/mark-all-read")
async def read_all_alerts(db: DbSession, user_id: CurrentUserId) -> dict:
    count = await mark_all_read(db, user_id)
    return {"data": {"updated": count}, "meta": None, "error": None}
