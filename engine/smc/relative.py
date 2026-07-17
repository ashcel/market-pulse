"""Relative strength + correlation vs BTC (port of relative.ts).

Dashboard-plane read models over the market snapshot's existing 1H series —
display-only, consumed by no engine decision path.
"""

import math
from dataclasses import dataclass

from smc.types import Candle

CORR_WINDOW_BARS = 168
CORR_MIN_RETURNS = 48


@dataclass(slots=True)
class RelativeRead:
    # Asset % change minus BTC % change over the last 24 hourly bars.
    rs_btc24h: float
    # Asset % change minus BTC % change over the last 168 hourly bars.
    rs_btc7d: float
    # Pearson correlation of time-aligned hourly returns over up to the last
    # 168 bars; None below 48 overlapping returns (too little to be meaningful).
    corr_btc7d: float | None


def _js_round(value: float) -> float:
    """JS Math.round — half toward +infinity."""
    return math.floor(value + 0.5)


def _round(value: float, digits: int = 2) -> float:
    scale = 10.0**digits
    return _js_round(value * scale) / scale


def _change_over_bars(candles: list[Candle], bars: int) -> float:
    """% change over the last `bars` bars — same convention as the snapshot's change24h/7d."""
    if not candles:
        return 0.0
    base = candles[max(0, len(candles) - 1 - bars)]
    if base.close == 0:
        return 0.0
    return _round((candles[-1].close - base.close) / base.close * 100)


def pearson(a: list[float], b: list[float]) -> float | None:
    """Pearson correlation; None when inputs are degenerate (zero variance / too short)."""
    n = min(len(a), len(b))
    if n < 2:
        return None
    xs = a[-n:]
    ys = b[-n:]
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = 0.0
    sxx = 0.0
    syy = 0.0
    for x, y in zip(xs, ys, strict=True):
        dx = x - mx
        dy = y - my
        sxy += dx * dy
        sxx += dx * dx
        syy += dy * dy
    if sxx == 0 or syy == 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def _aligned_returns(a: list[Candle], b: list[Candle]) -> tuple[list[float], list[float]]:
    """Time-aligned hourly returns for two candle series.

    Returns are computed bar-over-bar per series, then paired strictly by bar
    open time so a gap or length skew in one series can't shift the pairing.
    """
    b_return_by_time: dict[int, float] = {}
    for i in range(1, len(b)):
        if b[i - 1].close != 0:
            b_return_by_time[b[i].time] = b[i].close / b[i - 1].close - 1
    ra: list[float] = []
    rb: list[float] = []
    for i in range(1, len(a)):
        other = b_return_by_time.get(a[i].time)
        if other is None or a[i - 1].close == 0:
            continue
        ra.append(a[i].close / a[i - 1].close - 1)
        rb.append(other)
    return ra[-CORR_WINDOW_BARS:], rb[-CORR_WINDOW_BARS:]


def compute_relative_read(candles: list[Candle], btc_candles: list[Candle]) -> RelativeRead:
    """The full relative read for one asset's 1H series against BTC's."""
    ra, rb = _aligned_returns(candles, btc_candles)
    corr = pearson(ra, rb) if len(ra) >= CORR_MIN_RETURNS else None
    return RelativeRead(
        rs_btc24h=_round(_change_over_bars(candles, 24) - _change_over_bars(btc_candles, 24)),
        rs_btc7d=_round(_change_over_bars(candles, 168) - _change_over_bars(btc_candles, 168)),
        corr_btc7d=None if corr is None else _round(corr),
    )
