"""Operational readiness checks backed by existing durable state."""

import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.execution.position_ws_manager import position_ws_manager

STALE_AFTER = timedelta(hours=2)
WORKER_STALE_AFTER = timedelta(minutes=15)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _freshness(value: datetime | None, now: datetime, limit: timedelta = STALE_AFTER) -> str:
    if value is None:
        return "unknown"
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return "ok" if now - value <= limit else "stale"


def _memory_pct() -> int:
    values: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0])
        return round((1 - values["MemAvailable"] / values["MemTotal"]) * 100)
    except (OSError, KeyError, ValueError, ZeroDivisionError):
        return 0


async def build_health(db: AsyncSession) -> dict[str, Any]:
    now = datetime.now(tz=UTC)
    
    from app.execution.config import execution_settings
    
    environment = "production" if not execution_settings.TESTNET else "testnet"
    if not execution_settings.ENABLED:
        environment = "demo"
    
    checks: dict[str, Any] = {
        "database": "down",
        "worker": {"status": "unknown", "last_heartbeat": None},
        "websocket": position_ws_manager.health_status(),
        "sync": {
            "trades": "unknown",
            "forensics": "unknown",
            "catalysts": "unknown",
            "last_sync": {"trades": None, "forensics": None, "catalysts": None},
        },
        "resources": {
            "memory_pct": _memory_pct(),
            "disk_pct": round(shutil.disk_usage("/").used / shutil.disk_usage("/").total * 100),
        },
    }
    try:
        await db.execute(text("select 1"))
        checks["database"] = "ok"

        heartbeat = await db.scalar(text("select max(finished_at) from engine_run"))
        checks["worker"] = {
            "status": _freshness(heartbeat, now, WORKER_STALE_AFTER),
            "last_heartbeat": _iso(heartbeat),
        }

        trades = await db.scalar(text("select max(last_sync_at) from binance_review_keys"))
        forensics = await db.scalar(text("select max(created_at) from trade_forensics"))
        catalysts = await db.scalar(
            text("select max(last_ok_at) from ingest_state where source like 'rss:%'")
        )
        sync = checks["sync"]
        sync["trades"] = _freshness(trades, now)
        sync["forensics"] = _freshness(forensics, now)
        sync["catalysts"] = _freshness(catalysts, now)
        sync["last_sync"] = {
            "trades": _iso(trades),
            "forensics": _iso(forensics),
            "catalysts": _iso(catalysts),
        }
    except Exception:
        await db.rollback()

    if checks["database"] == "down":
        status = "down"
    elif checks["worker"]["status"] != "ok" or any(
        checks["sync"][name] != "ok" for name in ("trades", "forensics", "catalysts")
    ):
        status = "degraded"
    else:
        status = "ok"
    return {"status": status, "environment": environment, "checks": checks}
