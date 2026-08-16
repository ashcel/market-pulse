"""Upstream feeds for the new-listing screener.

Five providers, each answering exactly one question:

| Provider                      | Answers                                        |
|-------------------------------|------------------------------------------------|
| Binance Alpha token list      | which early tokens exist, with live stats       |
| Binance CMS catalog 48        | what is *scheduled* to list, and exactly when   |
| Binance spot `get-products`   | which tokens carry newListing/Seed/Launchpad    |
| Binance futures exchangeInfo  | which perps onboarded, and when                 |
| DexScreener / GeckoTerminal   | realtime pair flow + the CoinGecko id bridge    |

Failure convention matches `app.worker.binance`: any network or parse problem
returns empty/None and is logged, never raised. This plane is a screener — a
dead provider must narrow the funnel, never take down the pass.

Everything here is I/O. The parsing rules that decide *meaning* live in
`smc.listing_calendar`, and the ranking lives in `smc.listing_score`.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from smc.listing_calendar import (
    ListingAnnouncement,
    extract_listing_time,
    flatten_article_body,
    parse_announcements,
)

logger = logging.getLogger("listings")

ALPHA_TOKEN_LIST = (
    "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list"
)
SPOT_PRODUCTS = "https://www.binance.com/bapi/asset/v1/public/asset-service/product/get-products"
CMS_LIST = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query"
CMS_DETAIL = "https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query"
FUTURES_EXCHANGE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo"
SPOT_KLINES = "https://api.binance.com/api/v3/klines"
FUTURES_KLINES = "https://fapi.binance.com/fapi/v1/klines"
DEXSCREENER_TOKEN = "https://api.dexscreener.com/latest/dex/tokens/{address}"
GECKOTERMINAL_TOKEN = "https://api.geckoterminal.com/api/v2/networks/{network}/tokens/{address}"
COINGECKO_COIN = "https://api.coingecko.com/api/v3/coins/{coin_id}"

# New Cryptocurrency Listing. The only catalog that carries listings.
LISTING_CATALOG_ID = 48
# The CMS rejects pageSize > 20 with a bare 400.
CMS_PAGE_SIZE = 20

# Binance's bapi endpoints 403 a bare client.
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; market-pulse/1.0)",
    "Accept": "application/json",
}

# Alpha chain names -> the slugs DexScreener/GeckoTerminal use.
CHAIN_SLUGS: dict[str, str] = {
    "BSC": "bsc",
    "Solana": "solana",
    "Base": "base",
    "Ethereum": "eth",
    "Arbitrum": "arbitrum",
    "Sui": "sui",
    "Sonic": "sonic",
    "TRON": "tron",
    "opBNB": "opbnb",
    "Polygon": "polygon_pos",
}

_client: httpx.AsyncClient | None = None


def http_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=25, headers=_HEADERS, follow_redirects=True)
    return _client


async def close_http_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


# Minimum seconds between calls to a host, applied per host. The two free
# providers below rate-limit aggressively (observed 429s at the fan-out rate
# a full pass produces), and a 429 costs the token its whole enrichment —
# pacing is cheaper than retrying. Binance's own endpoints are excluded: they
# are one bulk call each and carry a weight budget instead.
_HOST_MIN_INTERVAL: dict[str, float] = {
    "api.geckoterminal.com": 2.2,  # free tier is ~30 calls/min
    "api.coingecko.com": 2.5,  # keyless is stricter still
}
_last_call_at: dict[str, float] = {}
_host_locks: dict[str, asyncio.Lock] = {}


async def _throttle(host: str) -> None:
    interval = _HOST_MIN_INTERVAL.get(host)
    if interval is None:
        return
    lock = _host_locks.setdefault(host, asyncio.Lock())
    async with lock:
        loop = asyncio.get_running_loop()
        elapsed = loop.time() - _last_call_at.get(host, 0.0)
        if elapsed < interval:
            await asyncio.sleep(interval - elapsed)
        _last_call_at[host] = loop.time()


async def _get_json(url: str, params: dict[str, Any] | None = None) -> Any | None:
    await _throttle(httpx.URL(url).host)
    try:
        response = await http_client().get(url, params=params)
        if response.status_code != 200:
            logger.warning("listings: %s -> HTTP %s", url.split("?")[0], response.status_code)
            return None
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("listings: %s failed: %s", url.split("?")[0], exc)
        return None


def _as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None  # drop NaN


# ── Binance Alpha ────────────────────────────────────────────────────────────


@dataclass(slots=True)
class AlphaToken:
    """One row of the Alpha token list — the screener's primary universe.

    Alpha is where a token trades *before* Binance lists it on spot or perps,
    so this feed is the earliest structured view of a listing candidate that
    exists, and it already carries the stats a screener needs.
    """

    symbol: str
    name: str
    alpha_id: str
    chain: str | None
    contract_address: str | None
    icon_url: str | None
    price: float | None
    percent_change_24h: float | None
    volume_24h: float | None
    market_cap: float | None
    fdv: float | None
    liquidity: float | None
    total_supply: float | None
    circulating_supply: float | None
    holders: int | None
    trade_count_24h: int | None
    high_24h: float | None
    low_24h: float | None
    listing_time: datetime | None
    airdrop_live: bool
    tge_live: bool
    hot_tag: bool
    listed_cex: bool
    mul_point: int | None
    alpha_score: int | None
    offline: bool
    fully_delisted: bool


def _parse_alpha_token(row: dict[str, Any]) -> AlphaToken | None:
    symbol = (row.get("symbol") or "").strip().upper()
    if not symbol:
        return None
    listing_ms = row.get("listingTime")
    listing_time = (
        datetime.fromtimestamp(listing_ms / 1000, tz=UTC)
        if isinstance(listing_ms, (int, float)) and listing_ms > 0
        else None
    )
    holders = _as_float(row.get("holders"))
    trades = _as_float(row.get("count24h"))
    return AlphaToken(
        symbol=symbol,
        name=(row.get("name") or symbol).strip(),
        alpha_id=(row.get("alphaId") or "").strip(),
        chain=(row.get("chainName") or None),
        contract_address=(row.get("contractAddress") or None),
        icon_url=(row.get("iconUrl") or None),
        price=_as_float(row.get("price")),
        percent_change_24h=_as_float(row.get("percentChange24h")),
        volume_24h=_as_float(row.get("volume24h")),
        market_cap=_as_float(row.get("marketCap")),
        fdv=_as_float(row.get("fdv")),
        liquidity=_as_float(row.get("liquidity")),
        total_supply=_as_float(row.get("totalSupply")),
        circulating_supply=_as_float(row.get("circulatingSupply")),
        holders=int(holders) if holders is not None else None,
        trade_count_24h=int(trades) if trades is not None else None,
        high_24h=_as_float(row.get("priceHigh24h")),
        low_24h=_as_float(row.get("priceLow24h")),
        listing_time=listing_time,
        airdrop_live=bool(row.get("onlineAirdrop")),
        tge_live=bool(row.get("onlineTge")),
        hot_tag=bool(row.get("hotTag")),
        listed_cex=bool(row.get("listingCex")),
        mul_point=row.get("mulPoint") if isinstance(row.get("mulPoint"), int) else None,
        alpha_score=row.get("score") if isinstance(row.get("score"), int) else None,
        offline=bool(row.get("offline")),
        fully_delisted=bool(row.get("fullyDelisted")),
    )


async def fetch_alpha_tokens() -> list[AlphaToken]:
    payload = await _get_json(ALPHA_TOKEN_LIST)
    if not isinstance(payload, dict):
        return []
    rows = payload.get("data")
    if not isinstance(rows, list):
        return []
    parsed = [_parse_alpha_token(row) for row in rows if isinstance(row, dict)]
    return [token for token in parsed if token is not None]


# ── Binance spot products ────────────────────────────────────────────────────


@dataclass(slots=True)
class SpotProduct:
    """A USDT spot pair carrying a new-listing tag."""

    symbol: str  # base asset
    pair: str
    name: str
    tags: tuple[str, ...]
    price: float | None
    quote_volume_24h: float | None
    circulating_supply: float | None
    open_24h: float | None
    high_24h: float | None
    low_24h: float | None


# Tags that mark a pair as an early/new listing worth screening.
NEW_LISTING_TAGS = frozenset({"newListing", "Seed", "Launchpad", "Launchpool"})
# Tokenized equities and TradFi wrappers are not crypto listings.
EXCLUDED_TAGS = frozenset({"bStocks"})


async def fetch_spot_new_listings() -> list[SpotProduct]:
    payload = await _get_json(SPOT_PRODUCTS)
    if not isinstance(payload, dict):
        return []
    rows = payload.get("data")
    if not isinstance(rows, list):
        return []

    out: list[SpotProduct] = []
    for row in rows:
        if not isinstance(row, dict) or row.get("q") != "USDT":
            continue
        tags = tuple(str(tag) for tag in (row.get("tags") or []))
        if not (NEW_LISTING_TAGS & set(tags)) or (EXCLUDED_TAGS & set(tags)):
            continue
        base = (row.get("b") or "").strip().upper()
        if not base:
            continue
        out.append(
            SpotProduct(
                symbol=base,
                pair=(row.get("s") or "").strip().upper(),
                name=(row.get("an") or base).strip(),
                tags=tags,
                price=_as_float(row.get("c")),
                quote_volume_24h=_as_float(row.get("qv")),
                circulating_supply=_as_float(row.get("cs")),
                open_24h=_as_float(row.get("o")),
                high_24h=_as_float(row.get("h")),
                low_24h=_as_float(row.get("l")),
            )
        )
    return out


# ── Binance futures onboarding ───────────────────────────────────────────────


@dataclass(slots=True)
class PerpOnboard:
    symbol: str  # base asset
    pair: str
    onboard_at: datetime
    contract_type: str


async def fetch_perp_onboards(*, limit_days: int = 120) -> list[PerpOnboard]:
    """Perps that onboarded recently, TradFi contracts excluded.

    `contractType` is what separates a real token listing from the daily
    stream of tokenized-equity perps, which would otherwise flood the
    screener — those carry TRADIFI_PERPETUAL.
    """
    payload = await _get_json(FUTURES_EXCHANGE_INFO)
    if not isinstance(payload, dict):
        return []
    symbols = payload.get("symbols")
    if not isinstance(symbols, list):
        return []

    now = datetime.now(UTC)
    out: list[PerpOnboard] = []
    for row in symbols:
        if not isinstance(row, dict):
            continue
        if row.get("contractType") != "PERPETUAL" or row.get("quoteAsset") != "USDT":
            continue
        onboard_ms = row.get("onboardDate")
        if not isinstance(onboard_ms, (int, float)) or onboard_ms <= 0:
            continue
        onboard_at = datetime.fromtimestamp(onboard_ms / 1000, tz=UTC)
        if (now - onboard_at).days > limit_days:
            continue
        base = (row.get("baseAsset") or "").strip().upper()
        if not base:
            continue
        out.append(
            PerpOnboard(
                symbol=base,
                pair=(row.get("symbol") or "").strip().upper(),
                onboard_at=onboard_at,
                contract_type="PERPETUAL",
            )
        )
    return sorted(out, key=lambda p: p.onboard_at, reverse=True)


# ── Binance announcements (the calendar) ─────────────────────────────────────


async def fetch_announcements(*, pages: int = 2) -> list[ListingAnnouncement]:
    """Recent listing-catalog articles, parsed and classified.

    Only titles are read here — the exact launch time needs a second call per
    article, so `hydrate_listing_times` does that for the few that matter.
    """
    articles: list[dict[str, Any]] = []
    for page in range(1, max(1, pages) + 1):
        payload = await _get_json(
            CMS_LIST,
            {
                "type": 1,
                "catalogId": LISTING_CATALOG_ID,
                "pageNo": page,
                "pageSize": CMS_PAGE_SIZE,
            },
        )
        if not isinstance(payload, dict):
            break
        catalogs = (payload.get("data") or {}).get("catalogs")
        if not isinstance(catalogs, list) or not catalogs:
            break
        rows = catalogs[0].get("articles")
        if not isinstance(rows, list) or not rows:
            break
        articles.extend(row for row in rows if isinstance(row, dict))

    return parse_announcements(articles)


async def fetch_announcement_listing_time(code: str) -> datetime | None:
    """The exact UTC launch time, which only exists in the article body."""
    payload = await _get_json(CMS_DETAIL, {"articleCode": code})
    if not isinstance(payload, dict):
        return None
    body = (payload.get("data") or {}).get("body")
    if not isinstance(body, str):
        return None
    try:
        import json

        tree = json.loads(body)
    except ValueError:
        return None
    return extract_listing_time(flatten_article_body(tree))


async def hydrate_listing_times(
    announcements: list[ListingAnnouncement], *, max_lookups: int = 12
) -> list[ListingAnnouncement]:
    """Fill `listing_at` for the newest real listings.

    Bounded and sequential on purpose: this is the only per-article call in
    the pass, and the CMS is not a rate-limit budget worth spending. Newest
    first, because an old article's exact minute no longer matters.
    """
    targets = [a for a in announcements if a.is_listing and a.listing_at is None][:max_lookups]
    for announcement in targets:
        listing_at = await fetch_announcement_listing_time(announcement.code)
        if listing_at is not None:
            announcement.listing_at = listing_at
            announcement.listing_date = listing_at.date()
        await asyncio.sleep(0.25)
    return announcements


# ── launch price ─────────────────────────────────────────────────────────────


async def fetch_launch_price(
    pair: str, listed_at: datetime, *, market: str = "spot"
) -> float | None:
    """The OPEN of the first 1m candle at or after the listing minute.

    Binance's `startTime` returns the first bar whose open time is >= the
    value, and a kline's open is the first trade of that minute — so this is
    the actual first traded price, not an average. It is also backfillable:
    a token listed before this feature existed still gets a true launch price
    rather than "whatever it cost when we first looked".
    """
    url = FUTURES_KLINES if market == "perp" else SPOT_KLINES
    start_ms = int(listed_at.timestamp() * 1000)
    payload = await _get_json(
        url, {"symbol": pair, "interval": "1m", "startTime": start_ms, "limit": 1}
    )
    if not isinstance(payload, list) or not payload:
        return None
    first = payload[0]
    if not isinstance(first, list) or len(first) < 2:
        return None
    return _as_float(first[1])


async def fetch_last_price(pair: str, *, market: str = "spot") -> float | None:
    base = "https://fapi.binance.com/fapi/v1" if market == "perp" else "https://api.binance.com/api/v3"
    payload = await _get_json(f"{base}/ticker/price", {"symbol": pair})
    if not isinstance(payload, dict):
        return None
    return _as_float(payload.get("price"))


# ── DEX pair flow ────────────────────────────────────────────────────────────


@dataclass(slots=True)
class DexPair:
    """The deepest pair for a token, with its realtime taker flow."""

    chain: str
    dex: str
    pair_address: str
    url: str
    price_usd: float | None
    liquidity_usd: float | None
    market_cap_usd: float | None
    fdv_usd: float | None
    volume_24h_usd: float
    volume_1h_usd: float
    buys_5m: int
    sells_5m: int
    buys_1h: int
    sells_1h: int
    buys_24h: int
    sells_24h: int
    price_change_1h: float | None
    price_change_24h: float | None
    pair_created_at: datetime | None


def _txns(pair: dict[str, Any], window: str) -> tuple[int, int]:
    bucket = (pair.get("txns") or {}).get(window) or {}
    buys = bucket.get("buys")
    sells = bucket.get("sells")
    return (int(buys) if isinstance(buys, int) else 0, int(sells) if isinstance(sells, int) else 0)


async def fetch_dex_pair(contract_address: str) -> DexPair | None:
    """Deepest USD pair for a contract, or None.

    Deepest rather than newest: a token can have a dozen pairs and the thin
    ones carry noise flow that would dominate any count-based read.
    """
    if not contract_address:
        return None
    payload = await _get_json(DEXSCREENER_TOKEN.format(address=contract_address))
    if not isinstance(payload, dict):
        return None
    pairs = payload.get("pairs")
    if not isinstance(pairs, list) or not pairs:
        return None

    def depth(pair: Any) -> float:
        if not isinstance(pair, dict):
            return -1.0
        return _as_float((pair.get("liquidity") or {}).get("usd")) or 0.0

    best = max(pairs, key=depth)
    if not isinstance(best, dict):
        return None

    created_ms = best.get("pairCreatedAt")
    buys_5m, sells_5m = _txns(best, "m5")
    buys_1h, sells_1h = _txns(best, "h1")
    buys_24h, sells_24h = _txns(best, "h24")
    volume = best.get("volume") or {}
    change = best.get("priceChange") or {}

    return DexPair(
        chain=str(best.get("chainId") or ""),
        dex=str(best.get("dexId") or ""),
        pair_address=str(best.get("pairAddress") or ""),
        url=str(best.get("url") or ""),
        price_usd=_as_float(best.get("priceUsd")),
        liquidity_usd=_as_float((best.get("liquidity") or {}).get("usd")),
        market_cap_usd=_as_float(best.get("marketCap")),
        fdv_usd=_as_float(best.get("fdv")),
        volume_24h_usd=_as_float(volume.get("h24")) or 0.0,
        volume_1h_usd=_as_float(volume.get("h1")) or 0.0,
        buys_5m=buys_5m,
        sells_5m=sells_5m,
        buys_1h=buys_1h,
        sells_1h=sells_1h,
        buys_24h=buys_24h,
        sells_24h=sells_24h,
        price_change_1h=_as_float(change.get("h1")),
        price_change_24h=_as_float(change.get("h24")),
        pair_created_at=(
            datetime.fromtimestamp(created_ms / 1000, tz=UTC)
            if isinstance(created_ms, (int, float)) and created_ms > 0
            else None
        ),
    )


async def fetch_pool_launch_price(
    chain: str | None,
    pair_address: str,
    listed_at: datetime,
    *,
    token_address: str | None = None,
) -> float | None:
    """First hourly OPEN at or after listing, from the DEX pool's own OHLCV.

    This is the launch anchor for a token that only trades on Alpha and has
    no Binance kline to read. GeckoTerminal returns hourly bars newest-first
    from `before_timestamp`, so this asks for the window starting at the
    listing hour and takes the oldest bar in it.

    `token_address` is not optional in practice: without it the API prices the
    pool's *base* token, which is only sometimes ours — and a pool quoted the
    other way round yields an inverted anchor that silently turns into a fake
    -100% since-launch reading. Passing the contract pins the denomination.
    """
    network = CHAIN_SLUGS.get(chain or "")
    if not network or not pair_address:
        return None

    # 7 days of hourly bars after listing is far more than needed to find the
    # first one, and is a single request.
    before = int(listed_at.timestamp()) + 7 * 24 * 3600
    params: dict[str, Any] = {"limit": 168, "before_timestamp": before}
    if token_address:
        params["token"] = token_address
    payload = await _get_json(
        f"https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pair_address}/ohlcv/hour",
        params,
    )
    if not isinstance(payload, dict):
        return None
    ohlcv = (((payload.get("data") or {}).get("attributes")) or {}).get("ohlcv_list")
    if not isinstance(ohlcv, list) or not ohlcv:
        return None

    listing_ts = int(listed_at.timestamp())
    # Bars are [timestamp, open, high, low, close, volume], newest first.
    candidates = [
        bar
        for bar in ohlcv
        if isinstance(bar, list) and len(bar) >= 2 and isinstance(bar[0], (int, float))
        # Allow one hour of slack: the listing minute usually falls inside the
        # bar that opened before it.
        and bar[0] >= listing_ts - 3600
    ]
    if not candidates:
        return None
    oldest = min(candidates, key=lambda bar: bar[0])
    return _as_float(oldest[1])


async def fetch_coingecko_id(chain: str | None, contract_address: str | None) -> str | None:
    """GeckoTerminal knows the CoinGecko id for a raw contract address.

    That bridge is what makes community data reachable at all: a brand-new
    token is not in our curated `ASSET_IDS` table and never will be, so the
    id has to be discovered per token from the address.
    """
    network = CHAIN_SLUGS.get(chain or "")
    if not network or not contract_address:
        return None
    payload = await _get_json(
        GECKOTERMINAL_TOKEN.format(network=network, address=contract_address)
    )
    if not isinstance(payload, dict):
        return None
    attributes = ((payload.get("data") or {}).get("attributes")) or {}
    coin_id = attributes.get("coingecko_coin_id")
    return str(coin_id) if coin_id else None


@dataclass(slots=True)
class CommunityRead:
    coin_id: str
    sentiment_up_pct: float | None
    watchlist_users: int | None
    telegram_members: int | None
    twitter_handle: str | None
    homepage: str | None


async def fetch_community(coin_id: str) -> CommunityRead | None:
    """CoinGecko community block. Keyless works at low volume; a configured
    key just raises the ceiling."""
    payload = await _get_json(
        COINGECKO_COIN.format(coin_id=coin_id),
        {
            "localization": "false",
            "tickers": "false",
            "market_data": "false",
            "community_data": "true",
            "developer_data": "false",
            "sparkline": "false",
        },
    )
    if not isinstance(payload, dict) or not payload.get("id"):
        return None
    community = payload.get("community_data") or {}
    links = payload.get("links") or {}
    homepages = links.get("homepage") or []
    return CommunityRead(
        coin_id=str(payload.get("id")),
        sentiment_up_pct=_as_float(payload.get("sentiment_votes_up_percentage")),
        watchlist_users=payload.get("watchlist_portfolio_users")
        if isinstance(payload.get("watchlist_portfolio_users"), int)
        else None,
        telegram_members=community.get("telegram_channel_user_count")
        if isinstance(community.get("telegram_channel_user_count"), int)
        else None,
        twitter_handle=(links.get("twitter_screen_name") or None),
        homepage=(homepages[0] if isinstance(homepages, list) and homepages else None),
    )
