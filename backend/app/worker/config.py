"""arq worker settings — the Phase 4 replacement for market-pulse-worker.

One cron tick every 5 minutes runs the full forward-test pass (spot + perp
eval, then settle). arq's fixed cron job id means a still-running tick is
never overlapped — same guarantee the TS worker's sequential loop gave.

Run: `arq app.worker.config.WorkerSettings` (see deploy/market-pulse-arq.service).
"""

import logging
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

from arq import cron
from arq.connections import RedisSettings
from arq.cron import CronJob

from app.config import settings
from app.database import SessionFactory

from .alert_pass import run_alert_pass
from .binance import close_http_client
from .binance_review_sync_pass import run_binance_review_sync_pass
from .context_stamper import run_context_stamper_pass
from .forensics_pass import run_forensics_pass
from .passes import run_once

logging.basicConfig(level=logging.INFO, format="%(message)s")


async def health_ping(_ctx: dict[Any, Any]) -> str:
    """Liveness probe target (arq's job queue must round-trip)."""
    return "ok"


async def forward_test_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    """One full eval+settle pass over the universe (the worker heartbeat)."""
    return await run_once()


async def binance_review_sync_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    """Hourly background Binance realized-PnL sync for every active-keyed user."""
    sync_summary = await run_binance_review_sync_pass()
    forensics_summary = await run_forensics_pass()
    return f"{sync_summary}; {forensics_summary}"


async def context_stamper_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    async with SessionFactory() as db:
        written = await run_context_stamper_pass(db)
    return f"[context-stamper] stamped={written}"


async def alert_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    async with SessionFactory() as db:
        written = await run_alert_pass(db)
    return f"[alerts] written={written}"


async def shutdown(_ctx: dict[Any, Any]) -> None:
    await close_http_client()


class WorkerSettings:
    functions: ClassVar[list[Callable[[dict[Any, Any]], Awaitable[str]]]] = [health_ping]
    cron_jobs: ClassVar[list[CronJob]] = [
        cron(
            alert_tick,
            minute={1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56},
            run_at_startup=True,
            timeout=300,
        ),
        cron(
            forward_test_tick,
            minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55},
            run_at_startup=True,
            timeout=600,
        ),
        cron(
            context_stamper_tick,
            minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55},
            run_at_startup=True,
            timeout=300,
        ),
        cron(
            binance_review_sync_tick,
            hour=set(range(24)),
            minute={3},
            run_at_startup=False,
            timeout=900,
        ),
    ]
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(str(settings.REDIS_URL))
    keep_result = 300
