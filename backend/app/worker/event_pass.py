"""Token-event ingestion: pull each news source, classify items into typed
per-token events, and store them for the WHOLE worker universe. The dedup
unique index makes every re-ingestion a no-op, so the pass needs no cursor
and survives restarts for free — same idempotency philosophy as the
eval/settle passes. Port of the TS worker's event-pass.ts.

Sources are deliberately a pluggable list: a dedicated unlock-calendar API
(TokenUnlocks/CryptoRank/DeFiLlama-paid — all keyed/paid as of 2026-07-12)
can be added here later without touching the classifier or the store.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import httpx
from smc.news_rss import parse_rss_items
from smc.token_events import classify_token_events
from sqlalchemy.ext.asyncio import AsyncSession

from . import ingest_repo

logger = logging.getLogger("worker")


@dataclass(slots=True)
class EventSource:
    name: str
    url: str


# The Block is deliberately absent: its RSS sits behind Cloudflare bot
# blocking (403 for any non-browser client, verified 2026-07-13), and a
# permanently-erroring feed would keep context health degraded forever.
#
# TradFi/macro feeds (CNBC, MarketWatch) join the crypto set so equity + macro
# headlines flow through the same classifier — the user trades Binance-listed
# tokenized TradFi (SOXL, NVDA, SPY…) and macro (Fed/CPI/jobs) tags land under
# the reserved MARKET symbol. All verified 200 + parseable to a plain httpx
# client with this UA on 2026-07-22. (Reuters/Bloomberg RSS 403 bot-block, so
# they're deliberately absent, same reasoning as The Block.)
SOURCES: list[EventSource] = [
    EventSource("cointelegraph", "https://cointelegraph.com/rss"),
    EventSource("coindesk", "https://www.coindesk.com/arc/outboundfeeds/rss"),
    EventSource("decrypt", "https://decrypt.co/feed"),
    EventSource("cnbc-economy", "https://www.cnbc.com/id/20910258/device/rss/rss.html"),
    EventSource("cnbc-top", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    EventSource("marketwatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
]

# Tokenized-TradFi tickers we pull a per-ticker Yahoo Finance headline feed for,
# for equity-specific depth the broad feeds miss. Curated to US symbols that
# actually return items from Yahoo (SKHYNIX 200s but yields 0 items — a Korean
# listing Yahoo doesn't key on this symbol — so it's covered by the broad feeds
# + directory matching instead). Intersected each pass with the live
# TRADIFI_PERPETUAL directory so a delisted ticker is never fetched.
_TRADFI_YAHOO_PRIORITY: list[str] = [
    "SOXL",
    "SOXS",
    "NVDA",
    "TSLA",
    "SPY",
    "QQQ",
    "MSTR",
    "COIN",
    "AMD",
    "META",
]
_YAHOO_FEED = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}"

_FETCH_TIMEOUT_S = 10

# Full Binance directory (spot + perp bases) widens asset detection to
# out-of-universe tokens; cached ~1h like the legacy loader. An unreachable
# directory just narrows matching back to the universe for this pass. The same
# fetch also harvests the tokenized-TradFi base set: Binance marks those perps
# with contractType == "TRADIFI_PERPETUAL" (its own spelling), the authoritative
# way to enumerate them without a hardcoded list (and it excludes the crypto
# "DIA" token, which is a plain PERPETUAL).
_DIRECTORY_TTL_S = 3600
_directory_cache: tuple[float, list[str]] | None = None
_tradfi_cache: set[str] = set()


async def _load_tradable_directory(client: httpx.AsyncClient) -> list[str]:
    global _directory_cache, _tradfi_cache
    if _directory_cache is not None and time.monotonic() - _directory_cache[0] < _DIRECTORY_TTL_S:
        return _directory_cache[1]

    tickers: set[str] = set()
    tradfi: set[str] = set()
    for url in (
        "https://api.binance.com/api/v3/exchangeInfo",
        "https://fapi.binance.com/fapi/v1/exchangeInfo",
    ):
        try:
            response = await client.get(url, timeout=_FETCH_TIMEOUT_S)
            if response.status_code != 200:
                continue
            for symbol in response.json().get("symbols", []):
                if symbol.get("status") == "TRADING" and symbol.get("quoteAsset") == "USDT":
                    base = symbol.get("baseAsset")
                    if isinstance(base, str):
                        tickers.add(base)
                        if symbol.get("contractType") == "TRADIFI_PERPETUAL":
                            tradfi.add(base)
        except (httpx.HTTPError, ValueError, AttributeError):
            continue

    directory = sorted(tickers)
    if directory:
        _directory_cache = (time.monotonic(), directory)
        if tradfi:
            _tradfi_cache = tradfi
        return directory
    return _directory_cache[1] if _directory_cache is not None else []


def _tradfi_yahoo_sources() -> list[EventSource]:
    """Per-ticker Yahoo feeds for the priority tokenized-TradFi tickers that are
    actually live on Binance right now (∩ TRADIFI_PERPETUAL directory). Falls
    back to the full curated list if the directory hasn't loaded yet (its fetch
    failed this cycle) — the priority tickers are all known-good US symbols."""
    live = _tradfi_cache
    return [
        EventSource(f"yahoo-{t}", _YAHOO_FEED.format(ticker=t))
        for t in _TRADFI_YAHOO_PRIORITY
        if not live or t in live
    ]


@dataclass(slots=True)
class EventPassResult:
    fetched: int = 0
    inserted: int = 0


async def run_event_pass(db: AsyncSession, client: httpx.AsyncClient) -> EventPassResult:
    result = EventPassResult()
    directory = await _load_tradable_directory(client)
    for source in [*SOURCES, *_tradfi_yahoo_sources()]:
        try:
            response = await client.get(
                source.url,
                timeout=_FETCH_TIMEOUT_S,
                headers={"user-agent": "market-pulse/1.0"},
                follow_redirects=True,
            )
            if response.status_code != 200:
                raise RuntimeError(str(response.status_code))
            events = classify_token_events(
                parse_rss_items(response.text),
                source.name,
                time.time() * 1000,
                directory,
            )
            result.fetched += len(events)
            result.inserted += await ingest_repo.insert_token_events(db, events)
            await ingest_repo.upsert_ingest_state(db, f"rss:{source.name}", "ok")
        except Exception as err:
            # One dead feed must not starve the others; the next pass retries
            # anyway. The failure is still recorded per-feed so health can
            # name the dead one.
            await db.rollback()
            logger.error("[events] %s failed: %s", source.name, err)
            try:
                await ingest_repo.upsert_ingest_state(db, f"rss:{source.name}", "error", str(err))
            except Exception:
                await db.rollback()
    return result
