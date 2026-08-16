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
from app.listings.sources import close_http_client as close_listings_client

from .binance import close_http_client
from .binance_review_sync_pass import run_binance_review_sync_pass
from .forward_return_pass import run_forward_return_pass
from .listings_pass import run_listings_pass
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
    return await run_binance_review_sync_pass()


async def forward_return_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    """Evidence-plane ground truth — forward returns off closed 1H bars.

    Hourly, because the measurement is anchored to hourly closes: a faster
    tick would re-derive identical rows. Offset to :34 so it lands between
    the forward-test pass (:35) and the review sync (:03) without contending
    for the shared Binance weight budget. No flag: this plane measures, it
    never decides.
    """
    async with SessionFactory() as db:
        return await run_forward_return_pass(db)


async def listings_tick(ctx: dict[Any, Any], *args: Any, **kwargs: Any) -> str:  # noqa: ARG001
    """New-listing screener sweep.

    Every 15 minutes, offset off the :00/:05 marks so it never contends with
    the forward-test pass for the shared Binance weight budget. Faster than
    hourly because the thing it watches — a scheduled listing — is an event
    with a deadline, and a 15-minute resolution is what makes the "lists in
    under an hour" alert worth having.
    """
    async with SessionFactory() as db:
        return await run_listings_pass(db)


async def shutdown(_ctx: dict[Any, Any]) -> None:
    await close_http_client()
    await close_listings_client()


class WorkerSettings:
    functions: ClassVar[list[Callable[[dict[Any, Any]], Awaitable[str]]]] = [health_ping]
    cron_jobs: ClassVar[list[CronJob]] = [
        cron(
            forward_test_tick,
            minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55},
            run_at_startup=True,
            timeout=600,
        ),
        cron(
            binance_review_sync_tick,
            hour=set(range(24)),
            minute={3},
            run_at_startup=False,
            timeout=900,
        ),
        cron(
            forward_return_tick,
            hour=set(range(24)),
            minute={34},
            run_at_startup=False,
            timeout=600,
        ),
        cron(
            listings_tick,
            minute={7, 22, 37, 52},
            run_at_startup=True,
            timeout=900,
        ),
    ]
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(str(settings.REDIS_URL))
    keep_result = 300
