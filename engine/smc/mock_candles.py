"""Deterministic demo candles (port of mock-candles.ts).

The generator reproduces the TS mulberry32/FNV-style arithmetic bit-for-bit
(32-bit wrapping semantics), so a given (symbol, timeframe) always yields the
same series in both engines. Consumers must surface `source: "demo"` when
these candles reach a user.
"""

import math
from collections.abc import Callable
from typing import Literal

from smc.types import Candle

TokenTimeframe = Literal["15M", "30M", "1H", "4H", "1D", "1W"]

TOKEN_TIMEFRAMES: tuple[TokenTimeframe, ...] = ("15M", "30M", "1H", "4H", "1D", "1W")


def is_token_timeframe(value: object) -> bool:
    return value in TOKEN_TIMEFRAMES


_BASE_PRICE: dict[str, float] = {
    "BTC": 108_000,
    "ETH": 5_600,
    "SOL": 240,
    "BNB": 920,
    "XRP": 2.8,
    "ADA": 1.15,
    "DOGE": 0.32,
}

STEP_SECONDS: dict[TokenTimeframe, int] = {
    "15M": 15 * 60,
    "30M": 30 * 60,
    "1H": 60 * 60,
    "4H": 4 * 60 * 60,
    "1D": 24 * 60 * 60,
    "1W": 7 * 24 * 60 * 60,
}

_TIMEFRAME_VOLATILITY: dict[TokenTimeframe, float] = {
    "15M": 0.005,
    "30M": 0.007,
    "1H": 0.012,
    "4H": 0.018,
    "1D": 0.035,
    "1W": 0.07,
}

_U32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    """JS Math.imul — 32-bit wrapping multiply."""
    return ((a & _U32) * (b & _U32)) & _U32


def _hash_seed(text: str) -> int:
    h = (1779033703 ^ len(text)) & _U32
    for ch in text:
        h = _imul(h ^ ord(ch), 3432918353)
        h = ((h << 13) | (h >> 19)) & _U32
    return h


def _mulberry32(seed: int) -> Callable[[], float]:
    state = seed & _U32

    def rand() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _U32
        t = state
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _U32
        t &= _U32
        return ((t ^ (t >> 14)) & _U32) / 4294967296

    return rand


def _round_price(value: float) -> float:
    if value >= 1000:
        return round(value, 2)
    if value >= 10:
        return round(value, 3)
    return round(value, 5)


# 2026-07-05T00:00:00Z, matching the TS generator's fixed anchor.
_END_TIME = 1783296000


def generate_mock_candles(
    symbol: str,
    timeframe: TokenTimeframe,
    bars: int = 200,
) -> list[Candle]:
    ticker = symbol.upper()
    rand = _mulberry32(_hash_seed(f"{ticker}:{timeframe}"))
    step = STEP_SECONDS[timeframe]
    base = _BASE_PRICE.get(ticker, 25 + (_hash_seed(ticker) % 500))
    volatility = _TIMEFRAME_VOLATILITY[timeframe]
    drift = (rand() - 0.46) * volatility * 0.35
    phase = rand() * math.pi * 2
    close = base * (0.86 + rand() * 0.28)

    candles: list[Candle] = []
    for i in range(bars):
        time = _END_TIME - (bars - 1 - i) * step
        cycle = math.sin(i / 13 + phase) * volatility * 0.55
        shock = (rand() - 0.5) * volatility
        open_ = close
        close = max(base * 0.08, open_ * (1 + drift + cycle + shock))
        wick = max(open_, close) * (0.004 + rand() * volatility * 0.7)
        high = max(open_, close) + wick
        low = max(0.00001, min(open_, close) - wick * (0.7 + rand() * 0.8))
        volume_base = 800_000 + (_hash_seed(ticker) % 6_000_000)
        volume = round(volume_base * (0.65 + rand() * 1.3) * (1 + abs(cycle) * 12))

        candles.append(
            Candle(
                time=time,
                open=_round_price(open_),
                high=_round_price(high),
                low=_round_price(low),
                close=_round_price(close),
                volume=volume,
            )
        )
    return candles
