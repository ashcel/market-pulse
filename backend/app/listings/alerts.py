"""Telegram alerts for followed listings.

Delivery goes through the `hermes` CLI, the same path
`deploy/weekly-arms-report.sh` uses — the bot token lives in hermes' own
config and this process never sees it.

Four events are worth waking someone for, and nothing else:

- `listing_soon`   — a followed token lists within the hour
- `listed`         — it just started trading
- `grade_priority` — the screener promoted it to PRIORITY
- `drawdown`       — it is down hard from its launch price

Every alert is written to `token_listing_alerts` with a dedup key *before*
being considered sent, so a pass that runs every 15 minutes cannot send the
same "lists in 40 minutes" message four times. The key is coarse where the
event is continuous (a day bucket for grades, an hour bucket for countdowns)
and exact where the event happens once.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

from . import repo

logger = logging.getLogger("listings")

HERMES = "hermes"
# A followed token that drops this far below its launch price is worth saying
# out loud once a day.
DRAWDOWN_ALERT_PCT = -35.0
# "Lists soon" fires inside this window.
SOON_WINDOW_HOURS = 1.0


def _format_price(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 1:
        return f"${value:,.4f}".rstrip("0").rstrip(".")
    return f"${value:.8f}".rstrip("0").rstrip(".")


def build_message(row: Any, kind: str, *, now: datetime) -> str:
    """One Telegram message. Plain text — hermes does not assume markdown."""
    symbol = row.symbol
    name = row.name or symbol
    header = {
        "listing_soon": "LISTING SOON",
        "listed": "NOW TRADING",
        "grade_priority": "SCREENER: PRIORITY",
        "drawdown": "DOWN FROM LAUNCH",
    }.get(kind, kind.upper())

    lines = [f"[{header}] {symbol} — {name}"]

    if row.listing_at is not None:
        remaining = (row.listing_at - now).total_seconds() / 3600.0
        when = row.listing_at.strftime("%Y-%m-%d %H:%M UTC")
        if remaining > 0:
            lines.append(f"Lists {when} (in {remaining:.1f}h) on {row.listing_venue or 'Binance'}")
        else:
            lines.append(f"Listed {when} on {row.listing_venue or 'Binance'}")

    if row.current_price is not None:
        price_line = f"Price {_format_price(row.current_price)}"
        if row.pct_change_since_launch is not None:
            price_line += f" ({row.pct_change_since_launch:+.1f}% vs launch)"
        lines.append(price_line)

    if row.score is not None:
        coverage_pct = (row.coverage or 0) * 100
        lines.append(f"Score {row.score:.0f}/100 ({row.grade}), coverage {coverage_pct:.0f}%")

    shape: list[str] = []
    if row.liquidity:
        shape.append(f"liquidity ${row.liquidity:,.0f}")
    if row.market_cap:
        shape.append(f"cap ${row.market_cap:,.0f}")
    if row.holders:
        shape.append(f"{row.holders:,} holders")
    if shape:
        lines.append(", ".join(shape))

    warnings = ((row.score_detail or {}).get("warnings")) or []
    for warning in warnings[:3]:
        lines.append(f"! {warning}")

    lines.append("Screener read, not a trade signal.")
    return "\n".join(lines)


async def send_telegram(message: str) -> tuple[bool, str | None]:
    """Deliver via hermes. Returns `(delivered, error)`."""
    target = settings.LISTING_ALERT_TELEGRAM_TARGET
    if not target:
        return False, "no_telegram_target_configured"
    if shutil.which(HERMES) is None:
        return False, "hermes_not_installed"

    try:
        process = await asyncio.create_subprocess_exec(
            HERMES,
            "send",
            "--to",
            f"telegram:{target}",
            "--quiet",
            message,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
    except TimeoutError:
        return False, "hermes_timeout"
    except Exception as exc:
        return False, f"hermes_error:{type(exc).__name__}"

    if process.returncode == 0:
        return True, None
    return False, (stderr.decode()[:200] if stderr else f"hermes_exit_{process.returncode}")


def due_alerts(row: Any, *, now: datetime) -> list[tuple[str, str]]:
    """`(kind, dedup_key)` for every event this row currently satisfies.

    Pure so the trigger logic is testable without a DB or a subprocess.
    """
    due: list[tuple[str, str]] = []
    symbol = row.symbol

    if row.listing_at is not None:
        remaining_hours = (row.listing_at - now).total_seconds() / 3600.0
        listing_stamp = row.listing_at.strftime("%Y%m%dT%H%M")
        if 0 < remaining_hours <= SOON_WINDOW_HOURS:
            # Exact: one "lists soon" per scheduled listing, ever.
            due.append(("listing_soon", f"listing_soon|{symbol}|{listing_stamp}"))
        elif -6 <= remaining_hours <= 0:
            due.append(("listed", f"listed|{symbol}|{listing_stamp}"))

    if row.grade == "PRIORITY" and row.score is not None:
        # Daily bucket: a token that stays PRIORITY should not re-alert every
        # 15 minutes, but a fresh day is worth one reminder.
        day = now.strftime("%Y%m%d")
        due.append(("grade_priority", f"grade_priority|{symbol}|{day}"))

    if (
        row.pct_change_since_launch is not None
        and row.pct_change_since_launch <= DRAWDOWN_ALERT_PCT
    ):
        day = now.strftime("%Y%m%d")
        due.append(("drawdown", f"drawdown|{symbol}|{day}"))

    return due


async def dispatch_alerts(db: AsyncSession, row: Any, *, now: datetime | None = None) -> int:
    """Send whatever this row newly qualifies for. Returns the count sent.

    The alert row is written whether or not delivery succeeds — a failed send
    that is not recorded would retry forever, and the delivery error is more
    useful stored than logged.
    """
    reference = now or datetime.now(UTC)
    sent = 0

    for kind, dedup_key in due_alerts(row, now=reference):
        if await repo.alert_exists(db, dedup_key):
            continue
        message = build_message(row, kind, now=reference)
        delivered, error = await send_telegram(message)
        recorded = await repo.record_alert(
            db,
            symbol=row.symbol,
            kind=kind,
            dedup_key=dedup_key,
            message=message,
            delivered=delivered,
            delivery_error=error,
        )
        if recorded and delivered:
            sent += 1
        elif recorded and not delivered:
            logger.info("listings: alert %s not delivered: %s", dedup_key, error)

    if sent:
        await db.commit()
    return sent


def recent_window(hours: int = 24) -> datetime:
    return datetime.now(UTC) - timedelta(hours=hours)
