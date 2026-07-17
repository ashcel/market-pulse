from typing import Annotated

from fastapi import Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db

from .exceptions import InvalidTokenError
from .utils import decode_access_token


async def get_current_user_id(
    authorization: Annotated[str | None, Header()] = None,
) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise InvalidTokenError()
    token = authorization.removeprefix("Bearer ")
    payload = decode_access_token(token)
    user_id: str | None = payload.get("sub")
    if not user_id:
        raise InvalidTokenError()
    return user_id


CurrentUserId = Annotated[str, Depends(get_current_user_id)]
DbSession = Annotated[AsyncSession, Depends(get_db)]
