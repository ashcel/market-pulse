from fastapi import APIRouter

from app.auth.dependencies import CurrentUserId, DbSession

from .batch_service import UniverseSnapshot, build_universe

router = APIRouter(tags=["market"])


@router.get("/universe", response_model=UniverseSnapshot)
async def get_universe(db: DbSession, user_id: CurrentUserId) -> UniverseSnapshot:
    return await build_universe(db, user_id)
