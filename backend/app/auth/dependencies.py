import secrets
from typing import Annotated

from fastapi import Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db

from .exceptions import InvalidTokenError
from .utils import decode_access_token


async def get_current_user_id(
    authorization: Annotated[str | None, Header()] = None,
    x_internal_user_id: Annotated[str | None, Header()] = None,
    x_internal_key: Annotated[str | None, Header()] = None,
) -> str:
    """
    Accept either:
    1. A Bearer JWT token in the Authorization header (standard JWT auth).
    2. An X-Internal-Key + X-Internal-User-Id pair (server-to-server proxy calls
       from the TanStack Start server, which validates the session cookie itself).
    """
    # Server-to-server internal auth (higher priority, validated first)
    if x_internal_key and x_internal_user_id:
        if settings.INTERNAL_API_KEY and secrets.compare_digest(
            x_internal_key, settings.INTERNAL_API_KEY
        ):
            return x_internal_user_id
        raise InvalidTokenError()

    # Standard JWT Bearer auth
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
