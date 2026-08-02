"""arq worker settings — the Phase 4 replacement for market-pulse-worker.

One cron tick every 5 minutes runs the full forward-test pass (spot + perp
eval, then settle). arq's fixed cron job id means a still-running tick is
never overlapped — same guarantee the TS worker's sequential loop gave.

Run: `arq app.worker.config.WorkerSettings` (see deploy/market-pulse-arq.service).
"""

import logging
from collections.abc import Awaitable, Callable
from datetime import UTC
from typing import Any, ClassVar

from arq import cron
from arq.connections import RedisSettings
from arq.cron import CronJob

from app.config import settings
from app.database import SessionFactory
from app.delivery.service import run_delivery_pass
from app.execution.models import (
    TradePermit,  # noqa: F401  # register trade_permits so Alert.source_decision_id FK resolves in worker metadata
)
from app.scorecard.service import run_scorecard_pass

from .alert_pass import run_alert_pass
from .binance import close_http_client
from .binance_review_sync_pass import run_binance_review_sync_pass
from .context_stamper import run_context_stamper_pass
from .derivatives_pass import run_derivatives_pass
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


async def delivery_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    """Sprint 1 "satu mulut" delivery pass. Ticks every minute regardless —
    `run_delivery_pass` itself is the no-op gate on `DELIVERY_ENABLED=False`,
    so flipping the flag takes effect on the very next minute with no restart.
    """
    async with SessionFactory() as db:
        sent = await run_delivery_pass(db)
    return f"[delivery] sent={sent}"


async def scorecard_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    """Sprint 5 evidence pass — nightly at 00:00 UTC (07:00 WIB), the quiet
    hour (R4). Like delivery, the flag is checked *inside* the pass rather than
    at registration, so `SCORECARD_ENABLED=1` takes effect on the next midnight
    without restarting the worker.
    """
    async with SessionFactory() as db:
        return await run_scorecard_pass(db)


async def derivatives_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    """Derivatives Intelligence collection — one snapshot per universe symbol
    every 5 minutes. Registered unconditionally; `run_derivatives_pass` is the
    `DERIVATIVES_ENABLED` gate, so the flag takes effect on the next tick
    without a restart. Offset to minute 2/7/… so it never contends with the
    forward-test pass (:00) or the alert pass (:01) for the Binance weight
    budget they all share.
    """
    async with SessionFactory() as db:
        return await run_derivatives_pass(db)


async def shutdown(_ctx: dict[Any, Any]) -> None:
    await close_http_client()


class WorkerSettings:
    # arq schedules crons in the worker's timezone, which defaults to the
    # host's — and this box is Asia/Shanghai, so `hour={0}` would have meant
    # 16:00 UTC. Pinned to UTC because the plan specifies the scorecard pass at
    # 00:00 UTC. Every pre-existing cron here is either minute-based or spans
    # all 24 hours, so none of them move.
    timezone: ClassVar[Any] = UTC

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
        cron(
            delivery_tick,
            minute=set(range(60)),
            run_at_startup=True,
            timeout=120,
        ),
        cron(
            derivatives_tick,
            minute={2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57},
            # Never at startup: a deploy must not fire a universe-wide Binance
            # sweep the instant the worker comes back up.
            run_at_startup=False,
            timeout=280,
        ),
        cron(
            scorecard_tick,
            hour={0},
            minute={0},
            # Never at startup: a deploy at 14:00 must not trigger the nightly
            # scan outside its quiet window.
            run_at_startup=False,
            timeout=600,
        ),
    ]
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(str(settings.REDIS_URL))
    keep_result = 300
