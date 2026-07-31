"""Telegram Mini App login.

A Mini App hands the page an `initData` string signed by the bot token. It is
the *only* credential the webview has, so it has to carry the whole login:
prove the string was signed by our bot, prove it is fresh, prove the signing
Telegram user is the owner — and only then mint the ordinary Market Pulse
access token for the owner's user row.

Ported from the quant-notifier dashboard's `verifyInitData`
(`notifier-bot/src/dashboard/server.js`), which is the reference
implementation of https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app.

Rejection reasons are logged, never returned: telling a caller *why* their
forged initData failed helps them forge a better one.
"""

import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl

from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import select

from app.exceptions import AppError

from .exceptions import InvalidTokenError
from .models import User
from .utils import create_access_token

logger = logging.getLogger(__name__)

# Rejecting anything older than this limits replay of a leaked initData string.
INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60


class TelegramConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TELEGRAM_", env_file=".env", extra="ignore")

    bot_token: str = ""
    allowed_user_id: str = ""
    # The Market Pulse user row the Mini App acts as. `users.id` is a Postgres
    # uuid, so this is a string, not the int the Telegram side uses.
    owner_user_id: str = ""


telegram_settings = TelegramConfig()


class TelegramNotConfiguredError(AppError):
    status_code = 503
    code = "TELEGRAM_NOT_CONFIGURED"


@dataclass(frozen=True)
class InitDataCheck:
    ok: bool
    reason: str | None = None
    user: dict[str, Any] | None = None


def verify_telegram_init_data(
    init_data: str,
    bot_token: str,
    allowed_user_id: str = "",
    now: float | None = None,
) -> InitDataCheck:
    """Validate a Mini App initData string. `allowed_user_id` empty = signature
    and freshness only (no owner gate) — callers that serve owner data must
    pass it."""
    if not init_data or not bot_token:
        return InitDataCheck(False, "missing initData or bot token")

    # parse_qsl(keep_blank_values) mirrors URLSearchParams: the check string is
    # built from the decoded values, exactly as Telegram signs them.
    pairs = parse_qsl(init_data, keep_blank_values=True)
    hash_values = [v for k, v in pairs if k == "hash"]
    if not hash_values:
        return InitDataCheck(False, "no hash in initData")
    received_hash = hash_values[0]

    check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs) if k != "hash")

    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()

    # compare_digest, not ==: a plain compare leaks how much of the hash matched.
    if not hmac.compare_digest(expected, received_hash):
        return InitDataCheck(False, "hash mismatch")

    fields = dict(pairs)
    try:
        auth_date = int(fields.get("auth_date", "0"))
    except ValueError:
        auth_date = 0
    age = int(now if now is not None else time.time()) - auth_date
    if not auth_date or age > INIT_DATA_MAX_AGE_SECONDS:
        return InitDataCheck(False, f"initData too old ({age}s)")

    user: dict[str, Any] | None = None
    try:
        raw_user = fields.get("user")
        if raw_user:
            parsed = json.loads(raw_user)
            if isinstance(parsed, dict):
                user = parsed
    except (ValueError, TypeError):
        user = None

    # A valid signature proves "a real Telegram user", not "the owner".
    if allowed_user_id and (not user or str(user.get("id")) != str(allowed_user_id)):
        return InitDataCheck(False, "user is not the configured owner")

    return InitDataCheck(True, None, user)


async def login_with_init_data(init_data: str, db: Any) -> tuple[User, str, dict[str, Any] | None]:
    """Verify initData and return (owner user, access token, telegram user)."""
    cfg = telegram_settings
    if not cfg.bot_token:
        raise TelegramNotConfiguredError("Telegram login is not configured (TELEGRAM_BOT_TOKEN)")
    if not cfg.allowed_user_id:
        raise TelegramNotConfiguredError(
            "Telegram login is not configured (TELEGRAM_ALLOWED_USER_ID)"
        )

    check = verify_telegram_init_data(init_data, cfg.bot_token, cfg.allowed_user_id)
    if not check.ok:
        logger.warning("telegram auth rejected: %s", check.reason)
        raise InvalidTokenError()

    if not cfg.owner_user_id:
        raise TelegramNotConfiguredError(
            "Telegram login is not configured (TELEGRAM_OWNER_USER_ID)"
        )

    result = await db.execute(select(User).where(User.id == cfg.owner_user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise TelegramNotConfiguredError(
            "TELEGRAM_OWNER_USER_ID does not match any Market Pulse user"
        )

    return user, create_access_token(str(user.id)), check.user
