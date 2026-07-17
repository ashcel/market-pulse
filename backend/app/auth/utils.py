from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
import jwt

from .config import auth_settings
from .exceptions import InvalidTokenError


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def create_access_token(user_id: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "iat": now,
        "exp": now + timedelta(minutes=auth_settings.JWT_EXP_MINUTES),
    }
    return jwt.encode(payload, auth_settings.JWT_SECRET, algorithm=auth_settings.JWT_ALG)


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(
            token, auth_settings.JWT_SECRET, algorithms=[auth_settings.JWT_ALG]
        )
    except jwt.ExpiredSignatureError as exc:
        raise InvalidTokenError() from exc
    except jwt.InvalidTokenError as exc:
        raise InvalidTokenError() from exc
