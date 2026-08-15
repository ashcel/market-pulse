"""Slowly-changing facts about a symbol, cached so detection never waits.

The forward-test recorder freezes everything it knows at the instant of
detection and is forbidden from fetching (`recorder.snapshot_from`): a value
retrieved after the fact describes a later instant than the setup it claims to
belong to. But a perp's onboard date is not a value that moves — it is fixed
the day the contract lists. So it is fetched on its own slow timer and read at
detection as a dict lookup, which costs nothing and cannot introduce lookahead:
the map only ever gains symbols, and a symbol's date never changes once known.

Why this exists at all: across the first 264 settled setups, ~80% of gross R
came from five symbols, and the best-performing subset (`displacement`) drew
101% of its own edge from six symbols holding eight trades between them. That
is the signature of an instrument effect wearing a pattern's clothes. Listing
age is the cheapest candidate discriminator — a token that onboarded last week
trades nothing like one that has been listed two years — and it is the only one
of the useful symbol facts not already riding the ticker frame.

Failure convention is the Binance plane's: degrade, never raise. An unavailable
map yields `None`, which the record stores as "unknown" rather than as a
number, because a missing input must never read as a good one.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime

import httpx

logger = logging.getLogger(__name__)

FUTURES_EXCHANGE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo"

#: How long a fetched map is trusted. Onboard dates change only when a new
#: contract lists, so this is about picking up new symbols, not about staleness
#: of the existing ones.
REFRESH_SECONDS = 6 * 3600.0

#: A failed fetch is not retried on the hot path — the next scheduled refresh
#: tries again. This is how long to wait before the *first* retry after a
#: failure, so a Binance blip does not leave the map empty for six hours.
RETRY_SECONDS = 300.0

_TIMEOUT = httpx.Timeout(15.0, connect=10.0)


class OnboardMap:
    """Perp symbol → onboard datetime, refreshed on its own schedule.

    Reads (`age_days`) are pure dict lookups and never block or fetch. Refresh
    is explicit — the caller owns the timer, so this module starts no tasks of
    its own.
    """

    __slots__ = ("_dates", "_fetched_at", "_next_attempt")

    def __init__(self) -> None:
        self._dates: dict[str, datetime] = {}
        self._fetched_at: float = 0.0
        self._next_attempt: float = 0.0

    # ── read side (hot path) ─────────────────────────────────────────────────

    def age_days(self, symbol: str, now: float | None = None) -> float | None:
        """Days since this symbol's perp onboarded, or None if unknown.

        `symbol` is the base asset as the momentum plane canonicalises it
        (`BTC`, not `BTCUSDT`); both spellings are accepted so a caller never
        has to care.
        """
        onboard = self._dates.get(symbol.upper()) or self._dates.get(
            symbol.upper().removesuffix("USDT")
        )
        if onboard is None:
            return None
        ts = now if now is not None else time.time()
        return max(0.0, (ts - onboard.timestamp()) / 86400.0)

    @property
    def size(self) -> int:
        return len(self._dates)

    @property
    def is_stale(self) -> bool:
        return (time.time() - self._fetched_at) >= REFRESH_SECONDS

    # ── write side (slow timer) ──────────────────────────────────────────────

    async def refresh(self, *, force: bool = False) -> bool:
        """Re-fetch the map if it is due. True when the map was replaced.

        Never raises: a failure leaves the previous map in place — a map that
        is six hours old is worth far more than no map at all — and schedules a
        nearer retry.
        """
        now = time.time()
        if not force:
            if not self.is_stale:
                return False
            if now < self._next_attempt:
                return False

        try:
            dates = await _fetch_onboard_dates()
        except Exception as exc:
            self._next_attempt = now + RETRY_SECONDS
            logger.warning("[symbol-facts] onboard map refresh failed: %s", exc)
            return False

        if not dates:
            self._next_attempt = now + RETRY_SECONDS
            logger.warning("[symbol-facts] onboard map came back empty — keeping previous")
            return False

        self._dates = dates
        self._fetched_at = now
        self._next_attempt = 0.0
        logger.info("[symbol-facts] onboard map refreshed — %d symbols", len(dates))
        return True


async def _fetch_onboard_dates() -> dict[str, datetime]:
    """Every USDT perpetual's onboard date, keyed by base asset.

    Unlike `app.listings.sources.fetch_perp_onboards` this applies no recency
    window and keeps TradFi contracts out by the same `contractType` test — the
    forward test needs the age of *any* symbol it might detect on, not just the
    recent ones.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(FUTURES_EXCHANGE_INFO)
        response.raise_for_status()
        payload = response.json()

    return parse_onboard_dates(payload)


def parse_onboard_dates(payload: object) -> dict[str, datetime]:
    """Pure parse, split out so it can be tested without a network."""
    if not isinstance(payload, dict):
        return {}
    symbols = payload.get("symbols")
    if not isinstance(symbols, list):
        return {}

    out: dict[str, datetime] = {}
    for row in symbols:
        if not isinstance(row, dict):
            continue
        if row.get("contractType") != "PERPETUAL" or row.get("quoteAsset") != "USDT":
            continue
        onboard_ms = row.get("onboardDate")
        if not isinstance(onboard_ms, (int, float)) or onboard_ms <= 0:
            continue
        base = str(row.get("baseAsset") or "").strip().upper()
        if not base:
            continue
        out[base] = datetime.fromtimestamp(onboard_ms / 1000, tz=UTC)
    return out


#: The process-wide map. One instance because the fetch is whole-universe and
#: there is nothing symbol-specific to scope it by.
ONBOARD_MAP = OnboardMap()


async def keep_fresh(interval: float = 900.0) -> None:
    """Refresh loop, for a caller that wants to own it as a task.

    Ticks more often than `REFRESH_SECONDS` on purpose: `refresh` decides
    whether anything is actually due, so a short tick costs one comparison and
    lets a failed fetch retry promptly.
    """
    while True:
        await ONBOARD_MAP.refresh()
        await asyncio.sleep(interval)
