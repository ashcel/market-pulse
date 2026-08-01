"""Delivery pass — Sprint 1 "satu mulut" (docs/IMPLEMENTATION-PLAN.md §3 task
3). Runs every minute from the worker cron (`delivery_tick`), picks up
`alerts` rows still `delivery_state='pending'`, and sends each through the
one platform Telegram bot.

`DELIVERY_ENABLED=False` (the default) makes this a no-op — the cron keeps
ticking so the flip to `true` takes effect on the very next minute, with no
service restart. See `docs/IMPLEMENTATION-PLAN.md` Risiko R1: the flip is an
operator action done outside cryptoJob's operating hours, not a code change.
"""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.execution.alert_models import Alert, AlertSeverity

from .sender import send_telegram

WIB = ZoneInfo("Asia/Jakarta")

# 3 failed delivery passes (not 3 retries within one send — sender.py already
# retries transient errors internally) demote an alert out of the pending queue
# so it stops being retried forever.
_MAX_DELIVERY_ATTEMPTS = 3
_LOOKBACK = timedelta(hours=2)


def _in_quiet_hours(now: datetime) -> bool:
    hour = now.astimezone(WIB).hour
    start, end = settings.QUIET_HOURS_START, settings.QUIET_HOURS_END
    if start == end:
        return False
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def _deep_link(alert: Alert) -> str | None:
    if not alert.token_symbol:
        return None
    return f"https://iq.heydewi.com/token/{alert.token_symbol}"


def _message_text(alert: Alert) -> str:
    lines = [f"<b>{alert.title}</b>", alert.body]
    link = _deep_link(alert)
    if link:
        lines.append(link)
    return "\n".join(lines)


async def run_delivery_pass(db: AsyncSession) -> int:
    if not settings.DELIVERY_ENABLED:
        return 0

    now = datetime.now(UTC)
    quiet = _in_quiet_hours(now)
    cutoff = now - _LOOKBACK

    severity_order = case(
        (Alert.severity == AlertSeverity.CRITICAL.value, 0),
        (Alert.severity == AlertSeverity.WARNING.value, 1),
        (Alert.severity == AlertSeverity.INFO.value, 2),
        else_=99,
    )
    result = await db.execute(
        select(Alert)
        .where(Alert.delivery_state == "pending", Alert.created_at > cutoff)
        .order_by(severity_order, Alert.created_at)
    )
    candidates = list(result.scalars())

    sent = 0
    for alert in candidates:
        # Quiet hours only hold 'info' — critical/warning (position risk, etc.)
        # always send, per §2.2.
        if quiet and alert.severity == AlertSeverity.INFO.value:
            continue

        ok = await send_telegram(_message_text(alert), chat_id=settings.PLATFORM_CHAT_ID)
        if ok:
            alert.delivery_state = "sent"
            alert.delivered_at = datetime.now(UTC)
            sent += 1
        else:
            alert.delivery_attempts += 1
            if alert.delivery_attempts >= _MAX_DELIVERY_ATTEMPTS:
                alert.delivery_state = "failed"

    await db.commit()
    return sent
