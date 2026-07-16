"""Fair value gaps (port of fvg.ts) — the 3-candle imbalance (G5).

Bullish when low[i] > high[i-2], the gap being [high[i-2], low[i]]; bearish
mirror. Single forward pass over closed bars — replay-safe by construction.

Deliberately detection-only: filled/inverted state (iFVG, G6) is the lifecycle
deriver's job — an FVG's identity is fixed at formation. Display-plane only
for now (EDR 0012).
"""

from dataclasses import dataclass
from typing import Literal

from smc.mock_candles import TokenTimeframe
from smc.types import Candle
from smc.zones import SD_ZONE_TIMEFRAMES, atr_series

FvgKind = Literal["bullish", "bearish"]

# FVGs inherit the supply/demand timeframe gate: on 15M/30M the 3-candle
# imbalance fires constantly on noise.
FVG_TIMEFRAMES: tuple[TokenTimeframe, ...] = SD_ZONE_TIMEFRAMES

# G7 normalized size floor: gaps smaller than this fraction of ATR14 are
# spread noise. Applied only when ATR is measurable — an early-window gap is
# kept with size_atr=None rather than judged by a yardstick that doesn't exist.
MIN_FVG_SIZE_ATR = 0.25

_MAX_FVGS_PER_KIND = 3


@dataclass(slots=True)
class Fvg:
    # A bullish gap is a demand-side POI; bearish mirror.
    kind: FvgKind
    gap_low: float
    gap_high: float
    # The displacement (middle) candle that left the imbalance.
    time: int
    # The third candle — the closed bar that confirms the gap exists.
    confirm_time: int
    # Gap height / ATR14 as of the bar before the displacement; None when unavailable.
    size_atr: float | None
    # Gap height as % of the gap's mid price.
    size_pct: float


def detect_fvgs(candles: list[Candle]) -> list[Fvg]:
    """Every qualifying gap in the window, chronological by confirm time."""
    if len(candles) < 3:
        return []
    atr = atr_series(candles)
    out: list[Fvg] = []

    for i in range(2, len(candles)):
        first = candles[i - 2]
        third = candles[i]
        bullish = third.low > first.high
        bearish = third.high < first.low
        if not bullish and not bearish:
            continue

        gap_low = first.high if bullish else third.high
        gap_high = third.low if bullish else first.low
        gap = gap_high - gap_low
        if gap <= 0:
            continue

        # Reference ATR predates the displacement candle so the displacement's
        # own true range can't inflate the yardstick (same stance as zones).
        ref = atr[i - 2]
        size_atr = gap / ref if ref is not None and ref > 0 else None
        if size_atr is not None and size_atr < MIN_FVG_SIZE_ATR:
            continue

        mid = (gap_low + gap_high) / 2
        out.append(
            Fvg(
                kind="bullish" if bullish else "bearish",
                gap_low=gap_low,
                gap_high=gap_high,
                time=candles[i - 1].time,
                confirm_time=third.time,
                size_atr=size_atr,
                size_pct=(gap / mid) * 100 if mid > 0 else 0,
            )
        )

    return out


def select_fvgs(fvgs: list[Fvg]) -> list[Fvg]:
    """The display-ready subset: ranked candidates (preferred = [0]) — most
    recent first, larger gap breaking ties — overlapping same-kind duplicates
    dropped, capped per kind, mirroring zones' curation."""
    ranked = sorted(fvgs, key=lambda f: (-f.confirm_time, -(f.size_atr or 0)))
    picked: list[Fvg] = []
    for fvg in ranked:
        if sum(1 for p in picked if p.kind == fvg.kind) >= _MAX_FVGS_PER_KIND:
            continue
        overlaps = any(
            p.kind == fvg.kind and fvg.gap_low <= p.gap_high and fvg.gap_high >= p.gap_low
            for p in picked
        )
        if not overlaps:
            picked.append(fvg)
    return picked
