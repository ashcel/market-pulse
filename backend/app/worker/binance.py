"""Binance REST fetchers for the worker (port of the TS engine's binance.ts /
symbol-map.ts / rate-limit.ts fetch plane — the engine itself stays I/O-free).

Failure convention, unchanged from TS: any network/parse problem returns an
empty list / None. A missing feed must degrade the verdict inputs, never
crash a pass.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from dataclasses import replace

import httpx
from smc.mock_candles import TokenTimeframe
from smc.perp import PerpMetrics, PerpRead, interpret_perp
from smc.reaccumulation import OiPoint
from smc.types import Candle, MarketType

BINANCE_INTERVALS: dict[TokenTimeframe, str] = {
    "15M": "15m",
    "30M": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
}

_REST_BASE: dict[MarketType, str] = {
    "spot": "https://api.binance.com/api/v3",
    "perp": "https://fapi.binance.com/fapi/v1",
}
_FAPI_BASE = "https://fapi.binance.com"

# Binance quotes a handful of low-unit-price bases as a fixed multiple of the
# real token on USDS-M futures only. Single source for the rename (symbol-map.ts).
_FUTURES_BASE_OVERRIDES: dict[str, tuple[str, float]] = {
    "PEPE": ("1000PEPE", 1000),
    "SHIB": ("1000SHIB", 1000),
    "XEC": ("1000XEC", 1000),
    "LUNC": ("1000LUNC", 1000),
    "FLOKI": ("1000FLOKI", 1000),
    "BONK": ("1000BONK", 1000),
    "SATS": ("1000SATS", 1000),
    "RATS": ("1000RATS", 1000),
    "CAT": ("1000CAT", 1000),
    "MOG": ("1000000MOG", 1_000_000),
    "X": ("1000X", 1000),
    "CHEEMS": ("1000CHEEMS", 1000),
    "WHY": ("1000WHY", 1000),
    "BOB": ("1000000BOB", 1_000_000),
}


def normalize_ticker(raw: str) -> str:
    """Strips everything but letters/digits and uppercases — the one rule."""
    return re.sub(r"[^a-zA-Z0-9]", "", raw).upper()


def resolve_exchange_symbol(raw_ticker: str, market: MarketType) -> tuple[str, float]:
    """Exchange-facing symbol + price scale (divide prices by it)."""
    ticker = normalize_ticker(raw_ticker)
    if market == "perp":
        override = _FUTURES_BASE_OVERRIDES.get(ticker)
        if override is not None:
            return f"{override[0]}USDT", override[1]
    return f"{ticker}USDT", 1


def drop_unclosed_candle(candles: list[Candle]) -> list[Candle]:
    """Binance includes the still-forming bar as the last kline row. Signal
    generation must never react to an unclosed bar."""
    if len(candles) < 2:
        return candles
    closing = candles[-1]
    step = closing.time - candles[-2].time
    if step > 0 and time.time() < closing.time + step:
        return candles[:-1]
    return candles


class _WeightLimiter:
    """Token bucket over Binance's per-IP request-weight budget — a fraction
    of the real 6000/min ceiling so worker + web on one VPS IP can't get it
    banned (mirror of rate-limit.ts)."""

    def __init__(self, capacity_per_minute: float) -> None:
        self._capacity = capacity_per_minute
        self._tokens = capacity_per_minute
        self._refill_per_s = capacity_per_minute / 60
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, weight: float) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                refill = (now - self._last) * self._refill_per_s
                self._tokens = min(self._capacity, self._tokens + refill)
                self._last = now
                if self._tokens >= weight:
                    self._tokens -= weight
                    return
                await asyncio.sleep((weight - self._tokens) / self._refill_per_s)


_limiter = _WeightLimiter(2000)


def kline_weight(limit: int) -> int:
    """Binance's published weight schedule for GET /klines, keyed by limit."""
    if limit <= 100:
        return 1
    if limit <= 500:
        return 2
    return 5

TICKER_PRICE_WEIGHT = 2

_client: httpx.AsyncClient | None = None


def http_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=15)
    return _client


async def close_http_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _parse_klines(payload: object) -> list[Candle]:
    if not isinstance(payload, list):
        return []
    out: list[Candle] = []
    for row in payload:
        if not isinstance(row, list) or len(row) < 6:
            continue
        try:
            candle = Candle(
                time=int(float(row[0]) // 1000),
                open=float(row[1]),
                high=float(row[2]),
                low=float(row[3]),
                close=float(row[4]),
                volume=float(row[5]),
            )
        except (TypeError, ValueError):
            continue
        values = (candle.open, candle.high, candle.low, candle.close, candle.volume)
        if all(math.isfinite(v) for v in values):
            out.append(candle)
    return out


def _apply_price_scale(candles: list[Candle], price_scale: float) -> list[Candle]:
    if price_scale == 1:
        return candles
    return [
        replace(
            c,
            open=c.open / price_scale,
            high=c.high / price_scale,
            low=c.low / price_scale,
            close=c.close / price_scale,
            volume=c.volume * price_scale,
        )
        for c in candles
    ]


async def fetch_klines(
    symbol: str,
    timeframe: TokenTimeframe,
    limit: int = 200,
    market: MarketType = "spot",
    end_time: int | None = None,
) -> list[Candle]:
    interval = BINANCE_INTERVALS.get(timeframe)
    exchange_symbol, price_scale = resolve_exchange_symbol(symbol, market)
    if exchange_symbol == "USDT" or interval is None:
        return []

    limit = min(1000, max(1, int(limit)))
    params: dict[str, str] = {
        "symbol": exchange_symbol,
        "interval": interval,
        "limit": str(limit),
    }
    if end_time is not None and end_time > 0:
        params["endTime"] = str(int(end_time))

    try:
        await _limiter.acquire(kline_weight(limit))
        response = await http_client().get(f"{_REST_BASE[market]}/klines", params=params)
        if response.status_code != 200:
            return []
        return _apply_price_scale(_parse_klines(response.json()), price_scale)
    except httpx.HTTPError:
        return []


async def fetch_price(symbol: str, market: MarketType = "spot") -> float | None:
    """Current traded price, independent of any timeframe's candle close —
    anchors risk-plan entries so all timeframes quote the same price."""
    exchange_symbol, price_scale = resolve_exchange_symbol(symbol, market)
    if exchange_symbol == "USDT":
        return None
    try:
        await _limiter.acquire(TICKER_PRICE_WEIGHT)
        response = await http_client().get(
            f"{_REST_BASE[market]}/ticker/price", params={"symbol": exchange_symbol}
        )
        if response.status_code != 200:
            return None
        price = float(response.json().get("price", "nan"))
        return price / price_scale if math.isfinite(price) and price > 0 else None
    except (httpx.HTTPError, TypeError, ValueError):
        return None


def _num(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return math.nan


OPEN_INTEREST_HIST_WEIGHT = 1


async def fetch_oi_history(
    symbol: str, period: str = "1h", limit: int = 168
) -> list[OiPoint] | None:
    """Open-interest-value history for the reaccumulation detector, on the
    same futures endpoint `fetch_perp_context` already reads (period=1h here
    matches the 1H candles it gets aligned against). Best-effort like every
    other fetcher in this module: any failure returns None so a caller can
    degrade to the price-only read rather than crash."""
    pair, _price_scale = resolve_exchange_symbol(symbol, "perp")
    if pair == "USDT":
        return None
    try:
        await _limiter.acquire(OPEN_INTEREST_HIST_WEIGHT)
        response = await http_client().get(
            f"{_FAPI_BASE}/futures/data/openInterestHist",
            params={"symbol": pair, "period": period, "limit": str(min(500, max(1, limit)))},
        )
        if response.status_code != 200:
            return None
        payload = response.json()
        if not isinstance(payload, list):
            return None
        points: list[OiPoint] = []
        for row in payload:
            if not isinstance(row, dict):
                continue
            value = _num(row.get("sumOpenInterestValue"))
            timestamp = _num(row.get("timestamp"))
            if math.isfinite(value) and math.isfinite(timestamp):
                points.append(OiPoint(time=int(timestamp // 1000), value=value))
        points.sort(key=lambda p: p.time)
        return points
    except httpx.HTTPError:
        return None


async def fetch_perp_context(symbol: str) -> PerpRead | None:
    """Funding + OI positioning read (port of fetchPerpContextDirect)."""
    pair, price_scale = resolve_exchange_symbol(symbol, "perp")
    if pair == "USDT":
        return None

    try:
        premium_res, oi_res, candles = await asyncio.gather(
            http_client().get(f"{_FAPI_BASE}/fapi/v1/premiumIndex", params={"symbol": pair}),
            http_client().get(
                f"{_FAPI_BASE}/futures/data/openInterestHist",
                params={"symbol": pair, "period": "1h", "limit": "24"},
            ),
            fetch_klines(symbol, "1H", limit=24, market="perp"),
        )

        if premium_res.status_code != 200:
            return None
        premium = premium_res.json()
        funding_rate = _num(premium.get("lastFundingRate"))
        mark_price = _num(premium.get("markPrice")) / price_scale
        if not math.isfinite(funding_rate) or not math.isfinite(mark_price):
            return None

        # OI history is best-effort: if it fails we still return funding with
        # a flat OI trend rather than dropping the whole context.
        open_interest_value = math.nan
        oi_change_pct = 0.0
        if oi_res.status_code == 200:
            oi_hist = oi_res.json()
            if isinstance(oi_hist, list) and len(oi_hist) >= 2:
                first = _num(oi_hist[0].get("sumOpenInterestValue"))
                last = _num(oi_hist[-1].get("sumOpenInterestValue"))
                if math.isfinite(first) and math.isfinite(last) and first > 0:
                    open_interest_value = last
                    oi_change_pct = (last - first) / first * 100

        price_change_pct = (
            (candles[-1].close - candles[0].close) / candles[0].close * 100
            if len(candles) >= 2 and candles[0].close > 0
            else 0.0
        )

        return interpret_perp(
            PerpMetrics(
                funding_rate=funding_rate,
                funding_annualized_pct=funding_rate * 3 * 365 * 100,
                next_funding_ms=int(_num(premium.get("nextFundingTime")) or 0),
                mark_price=mark_price,
                open_interest_value=open_interest_value
                if math.isfinite(open_interest_value)
                else 0,
                oi_change_pct=oi_change_pct,
                price_change_pct=price_change_pct,
            )
        )
    except (httpx.HTTPError, TypeError, ValueError, AttributeError):
        return None
