"""Execution-key intake router — M9-T6 (EDR 0020 decision 4).

Manage execution keys (separate class from read-only Bybit sync keys).
Withdrawal-scoped keys are rejected at intake — always.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUserId
from app.database import get_db

from .exec_key_service import delete_exec_key, get_exec_key, intake_exec_key, mask_api_key

router = APIRouter(prefix="/execution/exec-key", tags=["execution"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


class KeyIntakeRequest(BaseModel):
    api_key: str
    api_secret: str
    testnet: bool = True


class KeyResponse(BaseModel):
    id: str
    user_id: str
    api_key_masked: str
    testnet: bool


@router.get("/", response_model=KeyResponse, summary="Get the current execution key (masked)")
async def get_key(
    db: DbSession,
    user_id: CurrentUserId,
) -> KeyResponse:
    key = await get_exec_key(db, user_id)
    return KeyResponse(
        id=key.id,
        user_id=key.user_id,
        api_key_masked=mask_api_key(key.api_key),
        testnet=key.testnet,
    )


@router.post(
    "/",
    response_model=KeyResponse,
    summary="Intake a Binance execution key (validates scope + IP allowlist at intake)",
)
async def create_key(
    req: KeyIntakeRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> KeyResponse:
    key = await intake_exec_key(db, user_id, req.api_key, req.api_secret, req.testnet)
    return KeyResponse(
        id=key.id,
        user_id=key.user_id,
        api_key_masked=mask_api_key(key.api_key),
        testnet=key.testnet,
    )


@router.delete("/", summary="Delete the stored execution key")
async def remove_key(
    db: DbSession,
    user_id: CurrentUserId,
) -> dict[str, str]:
    await delete_exec_key(db, user_id)
    return {"status": "ok"}
