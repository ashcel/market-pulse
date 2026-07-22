"""Economic-calendar ingestion: the keyless ForexFactory weekly JSON feed
(https://nfs.faireconomy.media/ff_calendar_thisweek.json, + nextweek when the
provider publishes it). Macro releases — Fed/FOMC, CPI, jobs reports, ECB,
tariffs, yields — are market-wide backdrop the user needs for both crypto and
tokenized TradFi.

Same idempotency/isolation philosophy as the event and unlock passes:

  * the economic_event dedup unique index makes re-ingestion a no-op, so no
    cursor is needed and a restart just re-ingests harmlessly;
  * each source URL is fetched under its own try/except and recorded per-source
    in ingest_state, so one dead feed (nextweek 404s outside its window) never
    starves the other;
  * the calendar only shifts on the order of days, so an in-process TTL keeps
    the refetch to ~every 2h regardless of how often the pass is invoked.

Port target has no TS counterpart — Python-native, like the DeFiLlama unlocks.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from smc.econ_events import normalize_forexfactory_events
from sqlalchemy.ext.asyncio import AsyncSession

from . import ingest_repo

logger = logging.getLogger("worker")

_FETCH_TIMEOUT_S = 15
# The weekly calendar barely moves intraday; refetch at most every ~2h.
_REFETCH_TTL_S = 2 * 60 * 60
# Occurred macro rows age out — the calendar is a forward-looking surface. A
# little lookback is kept so "earlier today" prints still resolve.
_RETENTION_S = 3 * 24 * 60 * 60

_BASE = "https://nfs.faireconomy.media"

# name → weekly file. thisweek is always published; nextweek only exists inside
# the provider's window (404s otherwise — recorded, never fatal).
_FEEDS: list[tuple[str, str]] = [
    ("forexfactory", f"{_BASE}/ff_calendar_thisweek.json"),
    ("forexfactory-next", f"{_BASE}/ff_calendar_nextweek.json"),
]

_last_fetch_at = 0.0


@dataclass(slots=True)
class EconPassResult:
    fetched: int = 0
    written: int = 0
    skipped: bool = False


def _cutoff_iso(seconds_back: int) -> str:
    return (
        datetime.fromtimestamp(time.time() - seconds_back, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


async def run_econ_pass(
    db: AsyncSession, client: httpx.AsyncClient, *, force: bool = False
) -> EconPassResult:
    """Fetch + normalize + upsert the ForexFactory weekly calendar(s). Throttled
    to ~2h by an in-process TTL (``force`` bypasses it for tests). Every feed is
    isolated; the whole pass returns a result even if both feeds fail."""
    global _last_fetch_at
    result = EconPassResult()
    if not force and time.monotonic() - _last_fetch_at < _REFETCH_TTL_S:
        result.skipped = True
        return result
    _last_fetch_at = time.monotonic()

    for name, url in _FEEDS:
        try:
            response = await client.get(
                url,
                timeout=_FETCH_TIMEOUT_S,
                headers={"user-agent": "market-pulse/1.0"},
                follow_redirects=True,
            )
            if response.status_code != 200:
                raise RuntimeError(str(response.status_code))
            events = normalize_forexfactory_events(response.json(), source=name)
            result.fetched += len(events)
            result.written += await ingest_repo.upsert_economic_events(db, events)
            await ingest_repo.upsert_ingest_state(db, f"econ:{name}", "ok")
        except Exception as err:
            # One dead feed (nextweek routinely 404s) must not starve the other.
            await db.rollback()
            logger.error("[econ] %s failed: %s", name, err)
            try:
                await ingest_repo.upsert_ingest_state(db, f"econ:{name}", "error", str(err))
            except Exception:
                await db.rollback()

    # Retention is a courtesy sweep; a failure is harmless and retried next pass.
    try:
        await ingest_repo.prune_economic_events(db, _cutoff_iso(_RETENTION_S))
    except Exception:
        await db.rollback()

    return result
