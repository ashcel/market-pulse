"""Token-unlock calendar ingestion (DeFiLlama), the free/keyless replacement
for CoinMarketCal (retired 2026-07-18). Per pass:

  1. scope = WORKER_UNIVERSE + opened (tracked_token) + starred (user_watchlist)
  2. resolve each ticker → emissions slug (static seed → DB cache → runtime
     gecko_id join), caching the result (including negatives) in Postgres
  3. fetch each resolved protocol's emissions file (in-memory 24h cache to
     bound CDN bandwidth), normalize upcoming cliff unlocks, upsert

Same idempotency/isolation philosophy as the event pass: the catalyst dedup
key makes re-ingestion a no-op, and a single dead fetch never fails the tick.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import httpx
from smc.asset_ids import ASSET_IDS
from smc.catalyst_events import CatalystEventInput
from smc.market import WORKER_UNIVERSE
from smc.unlock_events import normalize_defillama_unlocks
from smc.unlock_slugs import UNLOCK_SLUG_BY_TICKER, candidate_slugs
from sqlalchemy.ext.asyncio import AsyncSession

from . import ingest_repo

logger = logging.getLogger("worker")

_FETCH_TIMEOUT_S = 20
_SLUGS_TTL_S = 24 * 60 * 60
_EMISSIONS_TTL_S = 24 * 60 * 60
# How long a resolved (or negatively-resolved) slug is trusted before we retry
# resolution — a token can gain an unlock schedule later.
_SLUG_CACHE_TTL_S = 7 * 24 * 60 * 60

_DATASETS = "https://defillama-datasets.llama.fi"

# Module-level caches survive across passes within one worker process; a restart
# just repopulates them on the first pass.
_slugs_cache: tuple[float, list[str]] | None = None
_emissions_cache: dict[str, tuple[float, object]] = {}


@dataclass(slots=True)
class UnlockPassResult:
    resolved: int = 0
    written: int = 0


async def _slug_list(client: httpx.AsyncClient) -> list[str]:
    global _slugs_cache
    if _slugs_cache and time.monotonic() - _slugs_cache[0] < _SLUGS_TTL_S:
        return _slugs_cache[1]
    resp = await client.get(f"{_DATASETS}/emissionsProtocolsList", timeout=_FETCH_TIMEOUT_S)
    resp.raise_for_status()
    data = resp.json()
    slugs = [s for s in data if isinstance(s, str)] if isinstance(data, list) else []
    if slugs:
        _slugs_cache = (time.monotonic(), slugs)
    return slugs


async def _emissions(client: httpx.AsyncClient, slug: str) -> object | None:
    """One protocol's emissions payload, cached ~24h. None on any fetch error
    (a missing file is common — protocols churn)."""
    hit = _emissions_cache.get(slug)
    if hit and time.monotonic() - hit[0] < _EMISSIONS_TTL_S:
        return hit[1]
    try:
        resp = await client.get(f"{_DATASETS}/emissions/{slug}", timeout=_FETCH_TIMEOUT_S)
        if resp.status_code != 200:
            return None
        payload: object = resp.json()
    except (httpx.HTTPError, ValueError):
        return None
    _emissions_cache[slug] = (time.monotonic(), payload)
    return payload


async def _search_gecko_id(client: httpx.AsyncClient, ticker: str) -> str | None:
    """CoinGecko id for an out-of-universe ticker via the light /search endpoint
    (no key needed): the top-ranked coin whose symbol matches exactly."""
    try:
        resp = await client.get(
            "https://api.coingecko.com/api/v3/search",
            params={"query": ticker},
            timeout=_FETCH_TIMEOUT_S,
        )
        if resp.status_code != 200:
            return None
        coins = resp.json().get("coins", [])
    except (httpx.HTTPError, ValueError, AttributeError):
        return None
    # /search returns coins already ordered by market-cap rank.
    for coin in coins:
        if isinstance(coin, dict) and str(coin.get("symbol", "")).upper() == ticker.upper():
            cid = coin.get("id")
            return cid if isinstance(cid, str) else None
    return None


async def _resolve_slug(
    db: AsyncSession, client: httpx.AsyncClient, ticker: str, slugs: list[str]
) -> str | None:
    """Ticker → emissions slug: static seed, then DB cache (TTL), then a runtime
    exact-gecko_id join. Result (including a negative) is cached in Postgres."""
    seed = UNLOCK_SLUG_BY_TICKER.get(ticker)
    if seed is not None:
        return seed

    cached = await ingest_repo.get_slug_cache(db, ticker)
    if cached is not None:
        slug, checked_at = cached
        age = time.time() - checked_at.timestamp()
        if age < _SLUG_CACHE_TTL_S:
            return slug  # may be None (cached negative)

    entry = ASSET_IDS.get(ticker)
    gecko = entry.coingecko_id if entry else await _search_gecko_id(client, ticker)
    resolved: str | None = None
    if gecko:
        for cand in candidate_slugs(ticker, gecko, None, slugs):
            payload = await _emissions(client, cand)
            if isinstance(payload, dict) and payload.get("gecko_id") == gecko:
                resolved = cand
                break
    await ingest_repo.upsert_slug_cache(db, ticker, gecko, resolved)
    return resolved


async def run_unlock_pass(db: AsyncSession, client: httpx.AsyncClient) -> UnlockPassResult:
    result = UnlockPassResult()
    try:
        slugs = await _slug_list(client)
    except (httpx.HTTPError, ValueError) as err:
        await ingest_repo.upsert_ingest_state(db, "defillama", "error", str(err))
        return result

    scope = {a.ticker for a in WORKER_UNIVERSE} | set(await ingest_repo.load_unlock_scope(db))
    now_ms = time.time() * 1000
    events: list[CatalystEventInput] = []
    for ticker in sorted(scope):
        try:
            slug = await _resolve_slug(db, client, ticker, slugs)
        except Exception as err:  # resolution must never fail the whole pass
            await db.rollback()
            logger.error("[unlocks] resolve %s failed: %s", ticker, err)
            continue
        if not slug:
            continue
        result.resolved += 1
        payload = await _emissions(client, slug)
        if payload is None:
            continue
        events.extend(normalize_defillama_unlocks(payload, ticker, slug, now_ms))

    if events:
        result.written = await ingest_repo.upsert_catalyst_events(db, events)
    await ingest_repo.upsert_ingest_state(db, "defillama", "ok")
    return result
