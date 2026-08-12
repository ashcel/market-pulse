"""The radar's SLOW lane: cached higher-timeframe context per symbol.

Two speeds, one page:

    FAST   all-market ticker feed -> 1m/3m/5m rolling metrics -> events   (2s)
    SLOW   4H/1H/15m/5m klines    -> structure engine -> MarketContext    (minutes)

This module is the slow one. It never runs on a scan tick, never blocks the
fast lane, and never touches Postgres. The scanner reads it with a plain dict
lookup (`get`) that cannot fail or wait; if a symbol has no context yet, its
cards simply say so until a refresh lands.

## What it fetches, and how little

Recomputing 4H structure for ~600 perps on every tick would be absurd, so:

* **Interest-scoped.** Only symbols the fast lane is actually tracking get
  fetched, declared each tick via `track()`. Interest expires, so a symbol that
  goes quiet stops costing anything.
* **Per-timeframe cadence.** A 4H candle closes every four hours; refreshing it
  every 15 minutes is already generous. Each timeframe has its own interval
  (`REFRESH_SECONDS`), so the 5m read moves while the 4H read sits still.
* **Budgeted.** Each pass fetches at most `CONTEXT_MAX_FETCHES_PER_TICK`
  klines, at `CONTEXT_CONCURRENCY` at a time, through the same weight limiter
  the rest of the Binance plane uses. A backlog drains over several passes
  instead of bursting.

Stability comes from `smc.market_context.build_context`, which only flips a
symbol's displayed bias after the new reading is confirmed.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Iterable

from smc.market_context import (
    CONTEXT_TIMEFRAMES,
    ContextConfig,
    ContextTimeframe,
    MarketContext,
    TimeframeRead,
    build_context,
    read_timeframe,
)
from smc.scan_profiles import MODES, PROFILES
from smc.structure_map import StructureMap
from smc.types import Candle

from app.momentum import config as cfg
from app.worker.binance import drop_unclosed_candle, fetch_klines

logger = logging.getLogger("momentum.context")

#: `(symbol, timeframe, limit) -> candles`. Injectable so tests drive the cache
#: from a synthetic tape rather than the network.
Fetcher = Callable[[str, ContextTimeframe, int], Awaitable[list[Candle]]]


async def _fetch_perp_klines(
    symbol: str, timeframe: ContextTimeframe, limit: int
) -> list[Candle]:
    # Perp klines: the radar's universe is USDS-M futures, so context must be
    # read off the same book the events came from.
    return await fetch_klines(symbol, timeframe, limit=limit, market="perp")


class ContextCache:
    """Per-symbol higher-timeframe context, refreshed on slow timers."""

    def __init__(
        self,
        config: ContextConfig | None = None,
        fetcher: Fetcher | None = None,
    ) -> None:
        self.config = config if config is not None else cfg.load_context_config()
        self._fetch: Fetcher = fetcher if fetcher is not None else _fetch_perp_klines
        # One context per (mode, symbol): the *reads* are shared, but scalp and
        # intraday weight them differently — a 1H-led badge and a 4H-led badge
        # are different answers from the same structure.
        self._contexts: dict[tuple[str, str], MarketContext] = {}
        self._reads: dict[str, dict[ContextTimeframe, TimeframeRead]] = {}
        self._fetched_at: dict[tuple[str, ContextTimeframe], float] = {}
        self._interest: dict[str, float] = {}
        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self.refreshes = 0

    # ── hot-path reads (never block) ────────────────────────────────────────

    def get(self, symbol: str, mode: str = "SCALP") -> MarketContext | None:
        return self._contexts.get((mode, symbol))

    def maps(self, symbol: str, timeframes: tuple[str, ...]) -> tuple[StructureMap, ...]:
        """Structure maps for the requested timeframes, highest first.

        A dict lookup over reads the slow lane already computed — the fast lane
        calls this every tick and must never pay for pivot detection.
        """
        reads = self._reads.get(symbol, {})
        out: list[StructureMap] = []
        for timeframe in timeframes:
            for name, read in reads.items():
                if name == timeframe and read.structure is not None:
                    out.append(read.structure)
        return tuple(out)

    def track(self, symbols: Iterable[str], now: float) -> None:
        """Declares which symbols the fast lane cares about right now. Cheap
        enough to call every scan tick."""
        for symbol in symbols:
            self._interest[symbol] = now

    def __len__(self) -> int:
        return len(self._contexts)

    # ── lifecycle ───────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(self._loop(), name="momentum-context")

    async def stop(self) -> None:
        self._stopping = True
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

    async def _loop(self) -> None:
        while not self._stopping:
            try:
                await self.refresh_once(time.time())
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[momentum] context refresh failed")
            await asyncio.sleep(cfg.CONTEXT_TICK_SECONDS)

    # ── refresh ─────────────────────────────────────────────────────────────

    def _live_symbols(self, now: float) -> list[str]:
        """Symbols still of interest, newest interest first and capped."""
        self._interest = {
            symbol: last
            for symbol, last in self._interest.items()
            if now - last < cfg.CONTEXT_INTEREST_TTL_SECONDS
        }
        ordered = sorted(self._interest.items(), key=lambda item: -item[1])
        return [symbol for symbol, _ in ordered[: cfg.CONTEXT_MAX_SYMBOLS]]

    def _due(self, now: float) -> list[tuple[str, ContextTimeframe]]:
        """Every (symbol, timeframe) whose cached read has aged out, fastest
        timeframe first so the cheap, most-informative reads never starve
        behind a backlog of 4H refreshes."""
        due: list[tuple[str, ContextTimeframe]] = []
        live = self._live_symbols(now)
        for timeframe in reversed(CONTEXT_TIMEFRAMES):
            interval = cfg.CONTEXT_REFRESH_SECONDS[timeframe]
            for symbol in live:
                last = self._fetched_at.get((symbol, timeframe), 0.0)
                if now - last >= interval:
                    due.append((symbol, timeframe))
        return due[: cfg.CONTEXT_MAX_FETCHES_PER_TICK]

    async def refresh_once(self, now: float) -> int:
        """One refresh pass. Returns how many timeframe reads were updated.
        Separated from `_loop` so tests can drive it with an explicit clock."""
        due = self._due(now)
        if not due:
            return 0

        semaphore = asyncio.Semaphore(max(1, cfg.CONTEXT_CONCURRENCY))

        async def one(symbol: str, timeframe: ContextTimeframe) -> tuple[str, bool]:
            async with semaphore:
                # Mark the attempt regardless of outcome: a symbol whose klines
                # keep failing must not be retried every single pass.
                self._fetched_at[(symbol, timeframe)] = now
                candles = drop_unclosed_candle(
                    await self._fetch(symbol, timeframe, cfg.CONTEXT_KLINE_LIMIT)
                )
                read = read_timeframe(timeframe, candles, now, self.config)
                if read is None:
                    return symbol, False
                self._reads.setdefault(symbol, {})[timeframe] = read
                return symbol, True

        results = await asyncio.gather(*(one(s, t) for s, t in due), return_exceptions=True)

        updated = 0
        touched: set[str] = set()
        for result in results:
            if isinstance(result, BaseException):
                logger.debug("[momentum] context fetch error: %r", result)
                continue
            symbol, ok = result
            if ok:
                updated += 1
                touched.add(symbol)

        for symbol in touched:
            reads = tuple(self._reads.get(symbol, {}).values())
            for mode in MODES:
                key = (mode, symbol)
                self._contexts[key] = build_context(
                    symbol, reads, now, self._contexts.get(key), PROFILES[mode].context
                )

        # Forget symbols nobody is tracking any more, so the cache stays the
        # size of the radar rather than the size of the exchange.
        for context_key in list(self._contexts):
            if context_key[1] not in self._interest:
                del self._contexts[context_key]
                self._reads.pop(context_key[1], None)
        for fetch_key in [k for k in self._fetched_at if k[0] not in self._interest]:
            del self._fetched_at[fetch_key]

        self.refreshes += 1
        return updated
