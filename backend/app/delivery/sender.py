"""Platform Telegram sender — Sprint 1 "satu mulut" (docs/IMPLEMENTATION-PLAN.md
§3 task 2). Mirrors `notifier-bot/src/telegram.js#sendMessage` retry shape.

Send-only, on `PLATFORM_BOT_TOKEN` — a **different** token from the
notifier-bot's own bot. Never call `getUpdates` or `setWebhook` here: that
token pair already runs `tracking.js`'s FOLLOW/SKIP poller, and a second
`getUpdates` consumer on the same token would steal its callbacks (R2).
"""

import asyncio
import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = 1.5


def _api_url(method: str) -> str:
    return f"https://api.telegram.org/bot{settings.PLATFORM_BOT_TOKEN}/{method}"


async def send_telegram(
    text: str,
    *,
    chat_id: str,
    reply_markup: dict[str, Any] | None = None,
) -> bool:
    """POST sendMessage, parse_mode=HTML. Retries transient failures 3x with a
    1.5s * attempt backoff. Returns True only on a Telegram `ok: true` reply.
    """
    if not settings.PLATFORM_BOT_TOKEN or not chat_id:
        logger.warning("[delivery.sender] missing PLATFORM_BOT_TOKEN/chat_id, skipping send")
        return False

    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(_api_url("sendMessage"), json=payload)
                body = resp.json()
            if body.get("ok"):
                return True
            logger.error("[delivery.sender] send failed: %s", body)
            return False
        except (httpx.HTTPError, ValueError) as exc:
            if attempt < _MAX_ATTEMPTS:
                logger.warning(
                    "[delivery.sender] send attempt %d failed (%s), retrying...", attempt, exc
                )
                await asyncio.sleep(_BACKOFF_SECONDS * attempt)
                continue
            logger.error("[delivery.sender] send failed after %d attempts: %s", attempt, exc)
            return False
    return False
