from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUserId
from app.database import get_db
from app.pagination import PaginationMeta

from .schemas import (
    ConstitutionAuditListEnvelope,
    ConstitutionAuditResponse,
    ConstitutionCreate,
    ConstitutionDetailEnvelope,
    ConstitutionListEnvelope,
    ConstitutionResponse,
)
from .config import execution_settings
from .service import (
    create_constitution_version,
    get_current_constitution,
    list_constitution_audits,
    list_constitution_history,
)

router = APIRouter(prefix="/execution/constitution", tags=["execution"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.get(
    "/",
    response_model=ConstitutionDetailEnvelope,
    summary="Get the current (highest-version) trading constitution",
)
async def get_constitution(
    db: DbSession,
    user_id: CurrentUserId,
) -> ConstitutionDetailEnvelope:
    constitution = await get_current_constitution(db, user_id)
    return ConstitutionDetailEnvelope(
        data=ConstitutionResponse.model_validate(constitution),
        meta={"execution_enabled": execution_settings.ENABLED},
    )


@router.post(
    "/",
    response_model=ConstitutionDetailEnvelope,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new constitution version (validated + audited)",
)
async def create_constitution(
    payload: ConstitutionCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> ConstitutionDetailEnvelope:
    constitution = await create_constitution_version(db, user_id, payload, user_id)
    return ConstitutionDetailEnvelope(data=ConstitutionResponse.model_validate(constitution))


@router.get(
    "/history",
    response_model=ConstitutionListEnvelope,
    summary="List constitution version history, newest first",
)
async def get_constitution_history(
    db: DbSession,
    user_id: CurrentUserId,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
) -> ConstitutionListEnvelope:
    items, total = await list_constitution_history(db, user_id, page=page, per_page=per_page)
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return ConstitutionListEnvelope(
        data=[ConstitutionResponse.model_validate(c) for c in items],
        meta=meta.model_dump(),
    )


@router.get(
    "/audits",
    response_model=ConstitutionAuditListEnvelope,
    summary="List the constitution audit trail, newest first",
)
async def get_constitution_audits(
    db: DbSession,
    user_id: CurrentUserId,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
) -> ConstitutionAuditListEnvelope:
    items, total = await list_constitution_audits(db, user_id, page=page, per_page=per_page)
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return ConstitutionAuditListEnvelope(
        data=[ConstitutionAuditResponse.model_validate(a) for a in items],
        meta=meta.model_dump(),
    )
