"""External-context ingestion: poll keyed providers on the worker's slow
cadence and persist normalized rows, so the web process answers
/api/external-context from Postgres alone — provider keys and provider
latency never touch the request path. Port of the TS worker's context-pass.ts.

Same idempotency/isolation philosophy as the event pass: every provider is
wrapped in its own try/except, an outage is recorded in ingest_state (never
silent) and must never fail the forward-test tick.

Budget: one global-breadth call per 15-min pass is ~2.9k/month — comfortable
on both CoinGecko Demo (10k calls/mo) and CoinMarketCap Basic (10k+ credits/
mo at 1 credit/call), no retry needed beyond "next pass".
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

import httpx
from smc.asset_ids import COINMARKETCAL_IDS
from smc.catalyst_events import normalize_coinmarketcal_events
from smc.external_context import normalize_coingecko_global, normalize_coinmarketcap_global
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

from . import ingest_repo

logger = logging.getLogger("worker")

_FETCH_TIMEOUT_S = 10
_SNAPSHOT_RETENTION_S = 90 * 24 * 60 * 60

COINGECKO_SOURCE = "coingecko-global"
COINMARKETCAP_SOURCE = "coinmarketcap-global"
COINMARKETCAL_SOURCE = "coinmarketcal"

# The calendar changes on hours, not minutes, and CoinMarketCal free-tier
# rate limits are unverified — an inner 6h gate keeps us ≤16 calls/day
# regardless of the outer pass cadence.
_CALENDAR_PASS_S = 6 * 60 * 60
_last_calendar_at = 0.0

_CALENDAR_WINDOW_DAYS = 7
_CALENDAR_PAGE_MAX = 75
_CALENDAR_MAX_PAGES = 4
_OCCURRED_RETENTION_S = 30 * 24 * 60 * 60

GlobalStatus = Literal["ok", "unconfigured", "error"]
CalendarStatus = Literal["ok", "unconfigured", "error", "skipped"]


@dataclass(slots=True)
class ContextPassResult:
    global_: GlobalStatus
    calendar: CalendarStatus
    calendar_written: int | None = None


def _active_breadth_source() -> str:
    """The ingest_state source the current key configuration reports under."""
    if settings.COINGECKO_API_KEY or not settings.COINMARKETCAP_API_KEY:
        return COINGECKO_SOURCE
    return COINMARKETCAP_SOURCE


async def _ingest_global_breadth(db: AsyncSession, client: httpx.AsyncClient) -> GlobalStatus:
    # Either provider fully covers the breadth snapshot (dominance + total
    # mcap). CoinGecko is tried first when both keys exist; a single pass
    # never polls both — one row per tick is the budget.
    gecko_key = settings.COINGECKO_API_KEY
    cmc_key = settings.COINMARKETCAP_API_KEY
    if not gecko_key and not cmc_key:
        # Skipped is a recorded state, not silence — health reports it
        # distinctly from a failure, and it never degrades overall status.
        await ingest_repo.upsert_ingest_state(
            db,
            COINGECKO_SOURCE,
            "unconfigured",
            "neither COINGECKO_API_KEY nor COINMARKETCAP_API_KEY set",
        )
        return "unconfigured"
    if gecko_key:
        response = await client.get(
            "https://api.coingecko.com/api/v3/global",
            timeout=_FETCH_TIMEOUT_S,
            headers={"x-cg-demo-api-key": gecko_key, "accept": "application/json"},
        )
        if response.status_code != 200:
            raise RuntimeError(f"coingecko /global {response.status_code}")
        snapshot = normalize_coingecko_global(response.json())
        if snapshot is None:
            raise RuntimeError("coingecko /global: unexpected payload shape")
        await ingest_repo.insert_market_context_snapshot(db, snapshot)
        await ingest_repo.upsert_ingest_state(db, COINGECKO_SOURCE, "ok")
        return "ok"
    response = await client.get(
        "https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest",
        timeout=_FETCH_TIMEOUT_S,
        headers={"X-CMC_PRO_API_KEY": cmc_key, "accept": "application/json"},
    )
    if response.status_code != 200:
        raise RuntimeError(f"coinmarketcap global-metrics {response.status_code}")
    snapshot = normalize_coinmarketcap_global(response.json())
    if snapshot is None:
        raise RuntimeError("coinmarketcap global-metrics: unexpected payload shape")
    await ingest_repo.insert_market_context_snapshot(db, snapshot)
    await ingest_repo.upsert_ingest_state(db, COINMARKETCAP_SOURCE, "ok")
    return "ok"


async def _ingest_coinmarketcal(
    db: AsyncSession, client: httpx.AsyncClient
) -> tuple[Literal["ok", "unconfigured", "error"], int]:
    key = settings.COINMARKETCAL_API_KEY
    if not key:
        await ingest_repo.upsert_ingest_state(
            db, COINMARKETCAL_SOURCE, "unconfigured", "COINMARKETCAL_API_KEY not set"
        )
        return "unconfigured", 0
    now_ms = time.time() * 1000

    def fmt(ms: float) -> str:
        return datetime.fromtimestamp(ms / 1000, tz=UTC).date().isoformat()

    written = 0
    for page in range(1, _CALENDAR_MAX_PAGES + 1):
        params = {
            "dateRangeStart": fmt(now_ms),
            "dateRangeEnd": fmt(now_ms + _CALENDAR_WINDOW_DAYS * 24 * 60 * 60_000),
            "coins": ",".join(COINMARKETCAL_IDS),
            "max": str(_CALENDAR_PAGE_MAX),
            "page": str(page),
        }
        response = await client.get(
            "https://developers.coinmarketcal.com/v1/events",
            params=params,
            timeout=_FETCH_TIMEOUT_S,
            headers={"x-api-key": key, "accept": "application/json"},
        )
        # 429 = free-tier throttle; back off to the next 6h gate, not retry.
        if response.status_code != 200:
            raise RuntimeError(f"coinmarketcal /events page {page}: {response.status_code}")
        events = normalize_coinmarketcal_events(response.json(), now_ms)
        written += await ingest_repo.upsert_catalyst_events(db, events)
        if len(events) < _CALENDAR_PAGE_MAX:
            break  # last page
    await ingest_repo.upsert_ingest_state(db, COINMARKETCAL_SOURCE, "ok")
    return "ok", written


def _cutoff_iso(seconds_back: int) -> str:
    return (
        datetime.fromtimestamp(time.time() - seconds_back, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


async def run_context_pass(db: AsyncSession, client: httpx.AsyncClient) -> ContextPassResult:
    global _last_calendar_at
    global_status: GlobalStatus
    try:
        global_status = await _ingest_global_breadth(db, client)
    except Exception as err:
        global_status = "error"
        source = _active_breadth_source()
        await db.rollback()
        logger.error("[context] %s failed: %s", source, err)
        try:
            await ingest_repo.upsert_ingest_state(db, source, "error", str(err))
        except Exception:
            await db.rollback()

    calendar: CalendarStatus = "skipped"
    calendar_written: int | None = None
    if time.time() - _last_calendar_at >= _CALENDAR_PASS_S:
        _last_calendar_at = time.time()
        try:
            calendar, calendar_written = await _ingest_coinmarketcal(db, client)
        except Exception as err:
            calendar = "error"
            await db.rollback()
            logger.error("[context] %s failed: %s", COINMARKETCAL_SOURCE, err)
            try:
                await ingest_repo.upsert_ingest_state(
                    db, COINMARKETCAL_SOURCE, "error", str(err)
                )
            except Exception:
                await db.rollback()

    # Retention is a courtesy sweep; a failure is harmless and retried next pass.
    try:
        await ingest_repo.prune_market_context_snapshots(db, _cutoff_iso(_SNAPSHOT_RETENTION_S))
        await ingest_repo.prune_catalyst_events(db, _cutoff_iso(_OCCURRED_RETENTION_S))
    except Exception:
        await db.rollback()

    return ContextPassResult(
        global_=global_status, calendar=calendar, calendar_written=calendar_written
    )
