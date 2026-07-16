"""Core value types shared across the engine (port of types.ts)."""

from dataclasses import dataclass
from typing import Literal

ChartRange = Literal["1d", "1w", "1m", "6m", "1y", "5y", "max"]
PivotKind = Literal["high", "low"]
MarketType = Literal["spot", "perp"]


@dataclass(slots=True)
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(slots=True)
class PivotPoint:
    time: int
    price: float
    kind: PivotKind
