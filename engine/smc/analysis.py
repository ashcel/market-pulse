"""Pivot detection, trend lines, EMA (port of analysis.ts)."""

import math
from dataclasses import dataclass

from smc.structure import to_alternating_swings
from smc.types import Candle, PivotKind, PivotPoint

MAX_DISPLAY_PIVOTS = 8


@dataclass(slots=True)
class TrendLinePoint:
    time: int
    value: float


@dataclass(slots=True)
class TrendLines:
    support: list[TrendLinePoint]
    resistance: list[TrendLinePoint]


def pivot_window(candle_count: int) -> int:
    return min(12, max(3, math.ceil(candle_count / 40)))


def _is_pivot_at(candles: list[Candle], i: int, k: int, kind: PivotKind) -> bool:
    value = candles[i].high if kind == "high" else candles[i].low
    for j in range(i - k, i + k + 1):
        if j == i:
            continue
        other = candles[j].high if kind == "high" else candles[j].low
        if (other > value) if kind == "high" else (other < value):
            return False
        if other == value and j < i:
            return False
    return True


def _prominence_at(candles: list[Candle], i: int, k: int, price: float) -> float:
    closes = [candles[j].close for j in range(i - k, i + k + 1) if j != i]
    if not closes:
        return 0.0
    mean = sum(closes) / len(closes)
    stdev = math.sqrt(sum((c - mean) ** 2 for c in closes) / len(closes))
    return abs(price - mean) / max(stdev, 1e-8)


def _pivot_sort_key(pivot: PivotPoint) -> tuple[int, int]:
    # Time ascending; at equal times a low sorts before a high.
    return (pivot.time, 0 if pivot.kind == "low" else 1)


def compute_pivots(candles: list[Candle]) -> list[PivotPoint]:
    n = len(candles)
    k = pivot_window(n)
    if n < 2 * k + 1:
        return []

    found: list[PivotPoint] = []
    for i in range(k, n - k):
        if _is_pivot_at(candles, i, k, "high"):
            found.append(PivotPoint(time=candles[i].time, price=candles[i].high, kind="high"))
        if _is_pivot_at(candles, i, k, "low"):
            found.append(PivotPoint(time=candles[i].time, price=candles[i].low, kind="low"))

    return sorted(found, key=_pivot_sort_key)


def select_display_pivots(
    pivots: list[PivotPoint],
    candles: list[Candle],
    max_count: int = MAX_DISPLAY_PIVOTS,
) -> list[PivotPoint]:
    """Presentation-layer filter: the most prominent pivots for chart rendering.

    Engine logic must always consume the full set from compute_pivots.
    """
    if len(pivots) <= max_count:
        return pivots

    n = len(candles)
    k = pivot_window(n)
    index_by_time = {c.time: i for i, c in enumerate(candles)}

    def prominence(pivot: PivotPoint) -> float:
        idx = index_by_time.get(pivot.time)
        if idx is not None and k <= idx < n - k:
            return _prominence_at(candles, idx, k, pivot.price)
        return 0.0

    top = sorted(pivots, key=prominence, reverse=True)[:max_count]
    return sorted(top, key=_pivot_sort_key)


def _project_line(
    candles: list[Candle],
    index_by_time: dict[int, int],
    anchors: list[PivotPoint],
) -> list[TrendLinePoint]:
    if len(anchors) < 2:
        return []
    a, b = anchors[-2], anchors[-1]
    ia = index_by_time.get(a.time)
    ib = index_by_time.get(b.time)
    if ia is None or ib is None or ia == ib:
        return []
    slope = (b.price - a.price) / (ib - ia)
    return [
        TrendLinePoint(time=candles[i].time, value=a.price + slope * (i - ia))
        for i in range(ia, len(candles))
    ]


def compute_trend_lines(candles: list[Candle], pivots: list[PivotPoint]) -> TrendLines:
    """Anchor trend lines on alternation-validated swing legs, never raw
    same-kind pivots, so a line never connects two points from one leg."""
    index_by_time = {c.time: i for i, c in enumerate(candles)}
    swings = to_alternating_swings(pivots)
    return TrendLines(
        support=_project_line(candles, index_by_time, [p for p in swings if p.kind == "low"]),
        resistance=_project_line(candles, index_by_time, [p for p in swings if p.kind == "high"]),
    )


def compute_ema_series(candles: list[Candle], length: int) -> list[TrendLinePoint]:
    if length <= 0 or len(candles) < length:
        return []

    # Seed with the SMA of the first `length` closes, then roll the EMA forward.
    k = 2 / (length + 1)
    ema = sum(c.close for c in candles[:length]) / length
    points = [TrendLinePoint(time=candles[length - 1].time, value=ema)]

    for i in range(length, len(candles)):
        ema = candles[i].close * k + ema * (1 - k)
        points.append(TrendLinePoint(time=candles[i].time, value=ema))
    return points
