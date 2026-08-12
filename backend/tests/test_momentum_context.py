"""The radar's slow lane: `ContextCache`.

What matters here is not the structure maths (that is
`engine/tests/test_market_context.py`) but the *economics*: the cache must be
interest-scoped, per-timeframe rate-limited, budgeted per pass, and completely
absent from the fast lane's hot path.
"""

from __future__ import annotations

import math

import pytest
from smc.market_context import ContextTimeframe
from smc.types import Candle

from app.momentum import config as cfg
from app.momentum.context_cache import ContextCache

T0 = 1_700_000_000.0


async def refresh(cache: ContextCache, now: float, symbols: list[str]) -> int:
    """One pass, with interest re-declared first — the scanner re-declares on
    every 2s tick, so a long-lived symbol never falls out of scope."""
    cache.track(symbols, now)
    return await cache.refresh_once(now)


def wave(drift: float, count: int = 120, step: int = 3_600) -> list[Candle]:
    """Closed candles trending at `drift` per bar, with swings to give the
    structure engine something to label."""
    out: list[Candle] = []
    for index in range(count):
        mid = 100.0 + drift * index + 1.2 * math.sin(2 * math.pi * index / 12)
        out.append(
            Candle(
                time=int(T0) - (count - index) * step,
                open=mid,
                high=mid + 0.6,
                low=mid - 0.6,
                close=mid,
                volume=1_000.0,
            )
        )
    return out


class FakeFeed:
    """A kline source that records every request it is asked to serve."""

    def __init__(self, drift: float = 0.35) -> None:
        self.drift = drift
        self.calls: list[tuple[str, str]] = []

    async def __call__(
        self, symbol: str, timeframe: ContextTimeframe, _limit: int
    ) -> list[Candle]:
        self.calls.append((symbol, timeframe))
        return wave(self.drift)

    def count(self, timeframe: str) -> int:
        return sum(1 for _, tf in self.calls if tf == timeframe)


@pytest.mark.anyio
async def test_nothing_is_fetched_for_symbols_nobody_is_tracking() -> None:
    feed = FakeFeed()
    cache = ContextCache(fetcher=feed)
    assert await cache.refresh_once(T0) == 0
    assert feed.calls == []


@pytest.mark.anyio
async def test_a_tracked_symbol_gets_a_context() -> None:
    feed = FakeFeed(drift=0.35)
    cache = ContextCache(fetcher=feed)
    cache.track(["TST"], T0)
    updated = await cache.refresh_once(T0)

    # One read per context timeframe, 1D included for the swing horizon.
    assert updated == 5
    context = cache.get("TST")
    assert context is not None
    assert context.bias == "bullish"
    assert {read.timeframe for read in context.reads} == {"1D", "4H", "1H", "15M", "5M"}


@pytest.mark.anyio
async def test_a_bearish_tape_produces_the_mirrored_context() -> None:
    cache = ContextCache(fetcher=FakeFeed(drift=-0.35))
    cache.track(["TST"], T0)
    await cache.refresh_once(T0)
    context = cache.get("TST")
    assert context is not None
    assert context.bias == "bearish"


@pytest.mark.anyio
async def test_each_timeframe_refreshes_on_its_own_cadence() -> None:
    """The point of the slow lane: a 4H read is not re-fetched every minute."""
    feed = FakeFeed()
    cache = ContextCache(fetcher=feed)
    cache.track(["TST"], T0)
    await cache.refresh_once(T0)
    assert feed.count("4H") == 1 and feed.count("5M") == 1

    # A minute later only the 5m read is due.
    await refresh(cache, T0 + cfg.CONTEXT_REFRESH_SECONDS["5M"] + 1, ["TST"])
    assert feed.count("5M") == 2
    assert feed.count("4H") == 1
    assert feed.count("15M") == 1

    # Fifteen minutes later, everything is.
    await refresh(cache, T0 + cfg.CONTEXT_REFRESH_SECONDS["4H"] + 1, ["TST"])
    assert feed.count("4H") == 2


@pytest.mark.anyio
async def test_a_pass_is_budgeted_and_the_backlog_drains_over_several() -> None:
    feed = FakeFeed()
    cache = ContextCache(fetcher=feed)
    symbols = [f"T{index:02d}" for index in range(cfg.CONTEXT_MAX_FETCHES_PER_TICK)]
    cache.track(symbols, T0)

    await cache.refresh_once(T0)
    assert len(feed.calls) == cfg.CONTEXT_MAX_FETCHES_PER_TICK
    # Fastest timeframes first, so the cheap informative reads never starve.
    assert feed.count("5M") > 0

    await cache.refresh_once(T0 + 1)
    assert len(feed.calls) == 2 * cfg.CONTEXT_MAX_FETCHES_PER_TICK


@pytest.mark.anyio
async def test_interest_is_capped_so_the_cache_never_grows_to_the_exchange() -> None:
    feed = FakeFeed()
    cache = ContextCache(fetcher=feed)
    cache.track([f"T{index:03d}" for index in range(cfg.CONTEXT_MAX_SYMBOLS + 50)], T0)
    await cache.refresh_once(T0)
    assert len({symbol for symbol, _ in feed.calls}) <= cfg.CONTEXT_MAX_SYMBOLS


@pytest.mark.anyio
async def test_a_symbol_that_stops_being_tracked_is_forgotten() -> None:
    cache = ContextCache(fetcher=FakeFeed())
    cache.track(["TST"], T0)
    await cache.refresh_once(T0)
    assert cache.get("TST") is not None

    later = T0 + cfg.CONTEXT_INTEREST_TTL_SECONDS + 60
    cache.track(["OTHER"], later)
    await cache.refresh_once(later)
    assert cache.get("TST") is None
    assert cache.get("OTHER") is not None


@pytest.mark.anyio
async def test_a_failing_fetch_degrades_instead_of_raising() -> None:
    async def broken(_symbol: str, _tf: ContextTimeframe, _limit: int) -> list[Candle]:
        raise RuntimeError("binance is having a day")

    cache = ContextCache(fetcher=broken)
    cache.track(["TST"], T0)
    assert await cache.refresh_once(T0) == 0
    assert cache.get("TST") is None


@pytest.mark.anyio
async def test_too_little_history_yields_no_context_rather_than_a_guess() -> None:
    async def thin(_symbol: str, _tf: ContextTimeframe, _limit: int) -> list[Candle]:
        return wave(0.35, count=8)

    cache = ContextCache(fetcher=thin)
    cache.track(["TST"], T0)
    assert await cache.refresh_once(T0) == 0
    assert cache.get("TST") is None


@pytest.mark.anyio
async def test_the_badge_does_not_flip_on_one_disagreeing_refresh() -> None:
    """End-to-end stickiness: the tape reverses, the badge waits."""
    feed = FakeFeed(drift=0.35)
    cache = ContextCache(fetcher=feed)
    cache.track(["TST"], T0)
    await cache.refresh_once(T0)
    assert cache.get("TST").bias == "bullish"  # type: ignore[union-attr]

    feed.drift = -0.35
    step = cfg.CONTEXT_REFRESH_SECONDS["4H"] + 1
    await refresh(cache, T0 + step, ["TST"])
    assert cache.get("TST").bias == "bullish"  # type: ignore[union-attr]

    await refresh(cache, T0 + 2 * step, ["TST"])
    assert cache.get("TST").bias == "bearish"  # type: ignore[union-attr]
