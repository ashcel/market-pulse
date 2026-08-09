"""Live-evaluate + scan reads for the RALLY WATCHER detector.

Both entry points reuse the exact worker fetch helpers (`fetch_klines` /
`fetch_oi_history` / `fetch_funding_rate`) and the exact pure detector
(`smc.rally_watcher.evaluate_rally`) — nothing here re-derives the read, it
only fetches inputs and calls the shared function. Nothing is persisted:
`scan_rallies` holds a short-lived in-process cache only, never a
`signal_events` row.

The scan now covers `scan_universe_all()` (every Binance perp pair, per
Dee's "semua coin di binance async ya") rather than the gated top-120 —
a full sweep of ~400-600 symbols at `FETCH_CONCURRENCY=20` can take a couple
minutes, so a request never blocks on it: `scan_rallies()` always returns
whatever is cached instantly and kicks a background refresh
(`asyncio.create_task`) when that cache is stale or empty, guarded by
`_refresh_in_flight` so concurrent callers never double-schedule.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from smc.rally_watcher import RallyRead, evaluate_rally

from app.patterns.universe import scan_universe_all
from app.worker.binance import drop_unclosed_candle, fetch_funding_rate, fetch_klines, fetch_oi_history

logger = logging.getLogger("rally_watcher")

# 96 x 5m = 8h of lookback (LOOKBACK_BARS in the detector).
KLINE_LIMIT = 96
# A couple of OI samples is enough to flag oi_available; the detector's
# liquidation math never depends on OI depth.
OI_LIMIT = 4
# Bounded concurrency so an all-market scan doesn't starve the shared
# per-IP weight limiter (`app.worker.binance._limiter`) all at once.
FETCH_CONCURRENCY = 20
CACHE_TTL_SECONDS = 60.0


@dataclass(slots=True)
class RallyScanResult:
    updated_at: datetime
    universe_size: int
    rallies: list[RallyRead]
    # True while a background refresh is in flight, or the cache is still
    # empty (cold start) — lets the frontend show "scanning" instead of a
    # misleading "no rallies" empty state.
    scanning: bool = False


_cache: RallyScanResult | None = None
_cache_monotonic: float = 0.0
_cache_lock = asyncio.Lock()
_refresh_in_flight = False
_refresh_lock = asyncio.Lock()
# Handle to the currently-running background refresh, if any — kept so the
# FastAPI lifespan can best-effort cancel it on shutdown.
_refresh_task: asyncio.Task[None] | None = None


async def _evaluate_one(symbol: str, semaphore: asyncio.Semaphore) -> RallyRead | None:
    async with semaphore:
        try:
            candles = drop_unclosed_candle(
                await fetch_klines(symbol, "5M", limit=KLINE_LIMIT, market="perp")
            )
            if not candles:
                return None
            # Best-effort: a failed OI pull degrades the read (oi_available
            # False), never skips the symbol. Funding is skipped in the bulk
            # scan to keep sweep weight down for ~150 symbols — it never
            # gates or scores the read, only flavors the explanation text
            # (see evaluate_rally_live, which does fetch it for one symbol).
            oi_history = await fetch_oi_history(symbol, period="5m", limit=OI_LIMIT)
            return evaluate_rally(candles, oi_history, None, symbol=symbol)
        except Exception:
            logger.exception("[rally_watcher] %s evaluate failed", symbol)
            return None


async def _run_full_scan() -> RallyScanResult:
    """Fetches + evaluates the whole perp universe. No caching/locking here —
    callers own that."""
    universe = await scan_universe_all()
    semaphore = asyncio.Semaphore(FETCH_CONCURRENCY)
    results = await asyncio.gather(*(_evaluate_one(s, semaphore) for s in universe))
    rallies = sorted(
        (r for r in results if r is not None),
        key=lambda r: r.momentum_score,
        reverse=True,
    )
    return RallyScanResult(
        updated_at=datetime.now(tz=UTC), universe_size=len(universe), rallies=rallies
    )


async def _refresh_scan() -> None:
    """Background task body: recomputes the full scan and swaps it into the
    module cache. Never raises — a failed sweep logs and leaves the previous
    cache (if any) in place rather than surfacing a broken card."""
    global _cache, _cache_monotonic, _refresh_in_flight
    started = time.monotonic()
    try:
        result = await _run_full_scan()
        async with _cache_lock:
            _cache = result
            _cache_monotonic = time.monotonic()
        logger.info(
            "[rally_watcher] cold scan: universe=%d rallies=%d in %.1fs",
            result.universe_size,
            len(result.rallies),
            time.monotonic() - started,
        )
    except Exception:
        logger.exception("[rally_watcher] background scan failed")
    finally:
        async with _refresh_lock:
            _refresh_in_flight = False


def _schedule_refresh() -> None:
    """Fire-and-forget: spawns `_refresh_scan` unless one is already
    running. Callers must hold nothing — this manages its own locking."""
    global _refresh_in_flight, _refresh_task
    if _refresh_in_flight:
        return
    _refresh_in_flight = True
    _refresh_task = asyncio.create_task(_refresh_scan())


async def scan_rallies(force: bool = False) -> RallyScanResult:
    """Returns the cached scan instantly — never blocks on Binance. A stale
    or empty (cold-start) cache triggers a background refresh
    (`asyncio.create_task`) and returns immediately with `scanning=True`
    (empty cache) or the previous data as-is (stale-but-present cache, up to
    a minute old is fine). `force=True` still schedules a refresh
    synchronously wait-free — it does not block either; kept for tests/ops
    that want to assert a refresh was kicked."""
    async with _cache_lock:
        now = time.monotonic()
        fresh = _cache is not None and now - _cache_monotonic < CACHE_TTL_SECONDS
        if fresh and not force:
            return _cache

    if force or not fresh:
        _schedule_refresh()

    async with _cache_lock:
        if _cache is None:
            return RallyScanResult(
                updated_at=datetime.now(tz=UTC), universe_size=0, rallies=[], scanning=True
            )
        return RallyScanResult(
            updated_at=_cache.updated_at,
            universe_size=_cache.universe_size,
            rallies=_cache.rallies,
            scanning=_refresh_in_flight,
        )


async def start_rally_watcher_cold_start() -> None:
    """Kicks the first background scan at process startup (see
    `app.main`'s lifespan). Safe to call more than once — `_schedule_refresh`
    dedupes against an already-running refresh. Returns as soon as the task
    is scheduled; never awaits the scan itself."""
    _schedule_refresh()


async def stop_rally_watcher_cold_start() -> None:
    """Best-effort cancel of a still-running background refresh — called
    from `app.main`'s lifespan on shutdown so a scan mid-flight doesn't
    outlive the ASGI app. A no-op if no refresh is running."""
    task = _refresh_task
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass


async def evaluate_rally_live(symbol: str) -> RallyRead | None:
    """Live single-symbol read — powers a future token-page surface. Unlike
    the bulk scan, this also fetches funding (one extra call, one symbol)."""
    ticker = symbol.strip().upper()
    if not ticker:
        return None
    candles = drop_unclosed_candle(
        await fetch_klines(ticker, "5M", limit=KLINE_LIMIT, market="perp")
    )
    if not candles:
        return None
    oi_history, funding = await asyncio.gather(
        fetch_oi_history(ticker, period="5m", limit=OI_LIMIT),
        fetch_funding_rate(ticker),
    )
    return evaluate_rally(candles, oi_history, funding, symbol=ticker)
