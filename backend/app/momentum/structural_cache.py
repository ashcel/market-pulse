"""Slow-lane cache of *structural backing* for radar symbols.

The radar answers "what is happening in the next few minutes". The
REACCUMULATION detector answers something much slower — impulse, base, second
expansion over hours to days, from 1H candles on an hourly worker pass. The two
must not be merged into one stream: a positional pattern dropped into a
lifecycle whose stale timeout is five minutes would sit there for days,
distorting the funnel counts and contaminating a forward-test cohort built for
0.35% stops and two-hour holds.

What it *is* good for is context. "A bullish 3m displacement on a symbol that
has been building a reaccumulation base" is different information from the same
event on a symbol with no structural backing — the same argument that makes 4H
bias worth carrying.

## Recorded, not enforced

Nothing here gates detection. The cache is attached to the scanner's *view
model* (`RadarEntry`) and to the forward-test snapshot; `smc.situation`, which
decides state and `worth_watching`, never sees it. That placement is the
guarantee: a hunch about structural backing cannot quietly become a filter
until the forward test says it earns one.

## Cost

One indexed query every `STRUCTURAL_REFRESH_SECONDS` over rows the hourly
worker already wrote. The hot path only ever does a dict lookup, so Postgres
stays out of the radar's tick exactly as before.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass

from app.database import SessionFactory
from app.signals.repo import list_signals

logger = logging.getLogger("momentum.structural")

#: The reaccumulation writer's source id, as written by the hourly pass.
SOURCE = "reaccumulation"
#: How often the cache refreshes. The underlying pass is hourly, so anything
#: faster than this is spending queries on data that cannot have changed.
STRUCTURAL_REFRESH_SECONDS = 300.0
#: How many symbols to carry. The screen is already ranked by score.
MAX_SYMBOLS = 120
#: A backing read older than this is no longer describing the same base.
STALE_SECONDS = 6 * 3600.0


@dataclass(frozen=True, slots=True)
class StructuralBacking:
    """One symbol's slow structural read, as the screen last saw it."""

    symbol: str
    # 'ACCUMULATING' | 'SECOND_EXPANSION' — the detector's own vocabulary.
    state: str
    score: float
    side: str
    detected_at: float

    def is_stale(self, now: float) -> bool:
        return now - self.detected_at >= STALE_SECONDS


class StructuralCache:
    """Symbol → structural backing, refreshed on its own slow timer."""

    def __init__(self) -> None:
        self._backing: dict[str, StructuralBacking] = {}
        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self.refreshes = 0

    # ── hot-path read (never blocks) ────────────────────────────────────────

    def get(self, symbol: str, now: float | None = None) -> StructuralBacking | None:
        backing = self._backing.get(symbol)
        if backing is None:
            return None
        if now is not None and backing.is_stale(now):
            return None
        return backing

    def __len__(self) -> int:
        return len(self._backing)

    # ── lifecycle ───────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(self._loop(), name="momentum-structural")

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
                await self.refresh_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[momentum] structural refresh failed")
            await asyncio.sleep(STRUCTURAL_REFRESH_SECONDS)

    async def refresh_once(self) -> int:
        """One pass over the reaccumulation screen. Returns how many symbols
        carry backing afterwards. Separated from `_loop` so tests can drive it
        without a timer."""
        async with SessionFactory() as db:
            rows = await list_signals(
                db,
                source=SOURCE,
                limit=MAX_SYMBOLS,
                latest_per_symbol=True,
                sort="score",
            )
        fresh: dict[str, StructuralBacking] = {}
        for row in rows:
            features = row.features or {}
            score = features.get("score")
            fresh[row.symbol] = StructuralBacking(
                symbol=row.symbol,
                # The detector's state rides in its own payload; fall back to
                # the kind so a shape change degrades rather than crashes.
                state=str(features.get("state") or row.kind or "").upper(),
                score=float(score) if isinstance(score, (int, float)) else 0.0,
                side=row.side,
                detected_at=row.detected_at.timestamp(),
            )
        self._backing = fresh
        self.refreshes += 1
        return len(fresh)


_cache = StructuralCache()


def get_structural_cache() -> StructuralCache:
    return _cache


async def start_structural_cache() -> None:
    _cache.start()
    logger.info("[momentum] structural backing cache started")


async def stop_structural_cache() -> None:
    await _cache.stop()
