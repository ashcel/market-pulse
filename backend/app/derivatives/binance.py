"""The single place derivatives data is fetched from Binance USDⓈ-M.

All endpoints here are **public** — no API key, no signature, nothing that
could leak a secret into a log. The shared HTTP client, the per-IP
request-weight limiter and the 1000x contract renaming are imported from
`app.worker.binance` rather than reimplemented: one VPS IP serves the worker
and the web tier, so a second uncoordinated token bucket would be the thing
that gets us rate-limited.

Failure convention, unchanged from `app.worker.binance`: a network or parse
problem yields None for that field. A degraded snapshot is written with the
fields that did arrive; a missing feed must never crash a tick, and must never
be back-filled with a zero.

Liquidation data has no public Binance endpoint (the old
`allForceOrders` REST route was retired), so it is skipped silently — the spec
asks for it only "if available".
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from smc.asset_ids import ASSET_IDS

from app.worker.binance import (
    acquire_weight,
    http_client,
    normalize_ticker,
    resolve_exchange_symbol,
)

_FAPI = "https://fapi.binance.com"
_COINGECKO = "https://api.coingecko.com/api/v3"

# Binance's published weights for the endpoints used here.
_WEIGHT_OPEN_INTEREST = 1
_WEIGHT_PREMIUM_INDEX = 1
_WEIGHT_FUTURES_DATA = 1
_WEIGHT_KLINES = 1

# `futures/data/*` ratio series only exist at these periods; 5m matches the
# snapshot cadence so the stored row is the freshest published bucket.
_RATIO_PERIOD = "5m"

# Market caps move slowly and CoinGecko's keyless tier is ~10-30 calls/min for
# the whole box. One batched call per hour for the entire universe.
_MARKETCAP_TTL_S = 3600.0


@dataclass(frozen=True, slots=True)
class RawDerivatives:
    """One symbol's fetched state, already unwound from the 1000x contract
    scale and keyed by the canonical `<TICKER>USDT` symbol."""

    symbol: str
    timestamp: datetime
    open_interest: float | None
    open_interest_usd: float | None
    funding_rate: float | None
    long_short_ratio: float | None
    top_trader_accounts_ratio: float | None
    top_trader_positions_ratio: float | None
    taker_buy_volume: float | None
    taker_sell_volume: float | None
    basis: float | None
    premium: float | None
    oi_marketcap_ratio: float | None
    price: float | None


def _num(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def canonical_symbol(ticker: str) -> str:
    """`PEPE` / `pepeusdt` → `PEPEUSDT`. The storage key, never the 1000x
    contract name — see `models.py`."""
    cleaned = normalize_ticker(ticker).removesuffix("USDT")
    return f"{cleaned}USDT"


async def _get(path: str, params: dict[str, str], weight: int) -> object | None:
    try:
        await acquire_weight(weight)
        response = await http_client().get(f"{_FAPI}{path}", params=params)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        payload: object = response.json()
    except ValueError:
        return None
    return payload


async def fetch_open_interest(pair: str) -> float | None:
    """`fapi/v1/openInterest` — contracts outstanding right now. The USD leg
    comes from `openInterestHist`, which is the only place Binance publishes a
    notional; a missing history leaves it None rather than multiplying by a
    price we would then have to trust."""
    payload = await _get("/fapi/v1/openInterest", {"symbol": pair}, _WEIGHT_OPEN_INTEREST)
    if not isinstance(payload, dict):
        return None
    return _num(payload.get("openInterest"))


async def fetch_open_interest_hist(
    pair: str, *, period: str = _RATIO_PERIOD, limit: int = 2
) -> list[dict[str, float]]:
    """`futures/data/openInterestHist` — the OI series, including the USD
    notional. Used both for the current row's `open_interest_usd` and for the
    cold-start backfill that makes a 24h OI delta answerable on day one."""
    payload = await _get(
        "/futures/data/openInterestHist",
        {"symbol": pair, "period": period, "limit": str(max(1, min(500, limit)))},
        _WEIGHT_FUTURES_DATA,
    )
    if not isinstance(payload, list):
        return []
    rows: list[dict[str, float]] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        timestamp = _num(entry.get("timestamp"))
        oi = _num(entry.get("sumOpenInterest"))
        oi_value = _num(entry.get("sumOpenInterestValue"))
        if timestamp is None:
            continue
        row: dict[str, float] = {"timestamp": timestamp}
        if oi is not None:
            row["open_interest"] = oi
        if oi_value is not None:
            row["open_interest_usd"] = oi_value
        rows.append(row)
    return rows


async def fetch_premium_index(pair: str) -> dict[str, float | None]:
    """`fapi/v1/premiumIndex` — mark, index, the current funding rate and the
    next funding time. Basis and premium are derived from it here so no caller
    ever subtracts the two prices itself."""
    payload = await _get("/fapi/v1/premiumIndex", {"symbol": pair}, _WEIGHT_PREMIUM_INDEX)
    if not isinstance(payload, dict):
        return {}
    mark = _num(payload.get("markPrice"))
    index = _num(payload.get("indexPrice"))
    basis = None if mark is None or index is None else mark - index
    premium = None if basis is None or not index else basis / index
    return {
        "mark_price": mark,
        "index_price": index,
        "funding_rate": _num(payload.get("lastFundingRate")),
        "next_funding_time": _num(payload.get("nextFundingTime")),
        "basis": basis,
        "premium": premium,
    }


async def fetch_funding_rate(pair: str) -> float | None:
    """`fapi/v1/fundingRate` — the last *settled* rate. Only consulted when
    `premiumIndex` did not carry `lastFundingRate`, so the happy path costs no
    extra request."""
    payload = await _get(
        "/fapi/v1/fundingRate", {"symbol": pair, "limit": "1"}, _WEIGHT_FUTURES_DATA
    )
    if not isinstance(payload, list) or not payload:
        return None
    entry = payload[-1]
    return _num(entry.get("fundingRate")) if isinstance(entry, dict) else None


async def _fetch_ratio(path: str, pair: str, field: str) -> float | None:
    payload = await _get(
        path,
        {"symbol": pair, "period": _RATIO_PERIOD, "limit": "1"},
        _WEIGHT_FUTURES_DATA,
    )
    if not isinstance(payload, list) or not payload:
        return None
    entry = payload[-1]
    return _num(entry.get(field)) if isinstance(entry, dict) else None


async def fetch_long_short_ratio(pair: str) -> float | None:
    """`futures/data/globalLongShortAccountRatio` — the retail crowd."""
    return await _fetch_ratio("/futures/data/globalLongShortAccountRatio", pair, "longShortRatio")


async def fetch_top_trader_accounts_ratio(pair: str) -> float | None:
    """`futures/data/topLongShortAccountRatio` — how many of the top accounts
    are long, regardless of size."""
    return await _fetch_ratio("/futures/data/topLongShortAccountRatio", pair, "longShortRatio")


async def fetch_top_trader_positions_ratio(pair: str) -> float | None:
    """`futures/data/topLongShortPositionRatio` — how much of the top
    accounts' *notional* is long. The pair with the one above is what tells a
    few big longs apart from many small ones."""
    return await _fetch_ratio("/futures/data/topLongShortPositionRatio", pair, "longShortRatio")


async def fetch_taker_flow(pair: str) -> tuple[float | None, float | None, float | None]:
    """Taker buy/sell base volume and close from the last CLOSED 5m kline.

    Field 9 of a kline row is taker-buy base volume; sell volume is total
    minus buy. `limit=2` and taking `[-2]` drops the still-forming bar — an
    open bar's split flips around all the way to its close.
    """
    payload = await _get(
        "/fapi/v1/klines", {"symbol": pair, "interval": "5m", "limit": "2"}, _WEIGHT_KLINES
    )
    if not isinstance(payload, list) or not payload:
        return None, None, None
    row = payload[-2] if len(payload) >= 2 else payload[-1]
    if not isinstance(row, list) or len(row) < 10:
        return None, None, None
    close = _num(row[4])
    volume = _num(row[5])
    taker_buy = _num(row[9])
    if volume is None or taker_buy is None:
        return None, None, close
    return taker_buy, max(0.0, volume - taker_buy), close


# --- market cap ----------------------------------------------------------

_marketcap_cache: dict[str, float] = {}
_marketcap_fetched_at: float = 0.0


async def fetch_market_caps(tickers: list[str], *, now: float | None = None) -> dict[str, float]:
    """USD market caps for the universe, one batched CoinGecko call per hour.

    Keyed by bare ticker. A ticker with no `ASSET_IDS` entry, or a CoinGecko
    outage, simply produces no key — the caller then stores
    `oi_marketcap_ratio = NULL` rather than a ratio against a guessed cap.
    """
    global _marketcap_fetched_at
    clock = time.monotonic() if now is None else now
    if _marketcap_cache and clock - _marketcap_fetched_at < _MARKETCAP_TTL_S:
        return dict(_marketcap_cache)

    by_gecko_id: dict[str, str] = {}
    for ticker in tickers:
        entry = ASSET_IDS.get(ticker.upper())
        if entry is not None and entry.coingecko_id:
            by_gecko_id[entry.coingecko_id] = ticker.upper()
    if not by_gecko_id:
        return {}

    try:
        response = await http_client().get(
            f"{_COINGECKO}/simple/price",
            params={
                "ids": ",".join(sorted(by_gecko_id)),
                "vs_currencies": "usd",
                "include_market_cap": "true",
            },
        )
        if response.status_code != 200:
            return dict(_marketcap_cache)
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        return dict(_marketcap_cache)

    if not isinstance(payload, dict):
        return dict(_marketcap_cache)

    caps: dict[str, float] = {}
    for gecko_id, body in payload.items():
        mapped = by_gecko_id.get(str(gecko_id))
        if mapped is None or not isinstance(body, dict):
            continue
        cap = _num(body.get("usd_market_cap"))
        if cap is not None and cap > 0:
            caps[mapped] = cap
    if caps:
        _marketcap_cache.clear()
        _marketcap_cache.update(caps)
        _marketcap_fetched_at = clock
    return dict(_marketcap_cache)


def reset_marketcap_cache() -> None:
    """Test seam — the module-level cache would otherwise leak across cases."""
    global _marketcap_fetched_at
    _marketcap_cache.clear()
    _marketcap_fetched_at = 0.0


# --- assembly ------------------------------------------------------------


async def fetch_snapshot(
    ticker: str, *, timestamp: datetime, market_cap: float | None = None
) -> RawDerivatives:
    """One symbol's full derivatives read, sequential and best-effort.

    Sequential rather than gathered on purpose: 50 symbols x 7 endpoints
    bursting concurrently is exactly the shape that trips Binance's per-IP
    weight ceiling and takes the forward-test worker down with it. The shared
    limiter would serialise them anyway.

    Prices and open interest are divided/multiplied back out of Binance's
    1000x contract scale, so `RawDerivatives.price` is the real token price
    and `open_interest` the real token count.
    """
    pair, price_scale = resolve_exchange_symbol(ticker, "perp")

    open_interest = await fetch_open_interest(pair)
    hist = await fetch_open_interest_hist(pair, limit=1)
    open_interest_usd = hist[-1].get("open_interest_usd") if hist else None

    premium = await fetch_premium_index(pair)
    funding_rate = premium.get("funding_rate")
    if funding_rate is None:
        funding_rate = await fetch_funding_rate(pair)

    long_short_ratio = await fetch_long_short_ratio(pair)
    top_accounts = await fetch_top_trader_accounts_ratio(pair)
    top_positions = await fetch_top_trader_positions_ratio(pair)
    taker_buy, taker_sell, close = await fetch_taker_flow(pair)

    mark = premium.get("mark_price")
    price = mark if mark is not None else close
    basis = premium.get("basis")

    oi_ratio: float | None = None
    if open_interest_usd is not None and market_cap and market_cap > 0:
        oi_ratio = open_interest_usd / market_cap

    return RawDerivatives(
        symbol=canonical_symbol(ticker),
        timestamp=timestamp,
        # Contract count → token count; USD notional is scale-free.
        open_interest=None if open_interest is None else open_interest * price_scale,
        open_interest_usd=open_interest_usd,
        funding_rate=funding_rate,
        long_short_ratio=long_short_ratio,
        top_trader_accounts_ratio=top_accounts,
        top_trader_positions_ratio=top_positions,
        taker_buy_volume=None if taker_buy is None else taker_buy * price_scale,
        taker_sell_volume=None if taker_sell is None else taker_sell * price_scale,
        basis=None if basis is None else basis / price_scale,
        premium=premium.get("premium"),
        oi_marketcap_ratio=oi_ratio,
        price=None if price is None else price / price_scale,
    )


def floor_to_slot(moment: datetime, interval_s: int) -> datetime:
    """Snap onto the snapshot grid so a retried tick collides with itself."""
    aware = moment if moment.tzinfo else moment.replace(tzinfo=UTC)
    epoch = int(aware.timestamp())
    return datetime.fromtimestamp(epoch - epoch % interval_s, tz=UTC)
