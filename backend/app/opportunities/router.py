"""GET /api/v1/opportunities — the Ideas feed's data (Sprint 2 task 4).

Reads `signal_events` only. No upstream call: once this ships, the feed keeps
answering with quant-dashboard (:8787) stopped, which is the whole point of
Sprint 2 and one of its exit criteria.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Query

from app.auth.dependencies import CurrentUserId, DbSession

from .service import Opportunity, list_opportunities

router = APIRouter(prefix="/opportunities", tags=["opportunities"])


@router.get("", summary="Ranked opportunity cards from owned signal facts")
async def get_opportunities(
    db: DbSession,
    _user_id: CurrentUserId,
    horizon: Annotated[str | None, Query(max_length=16)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    lookback_days: Annotated[int, Query(ge=1, le=30)] = 2,
) -> dict[str, Any]:
    cards: list[Opportunity] = await list_opportunities(
        db, horizon=horizon, limit=limit, lookback_days=lookback_days
    )
    return {
        "data": [card.model_dump(mode="json") for card in cards],
        "meta": {"count": len(cards)},
        "error": None,
    }
