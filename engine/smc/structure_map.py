"""STRUCTURE MAP — one timeframe's swings and liquidity, in a compact shape.

`structure.py` labels swings and detects BOS/CHoCH; this module folds one of
its `MarketStructure` reads into the handful of *levels* the rest of the radar
needs: where the recent swing highs and lows are, and which of them are equal
(i.e. resting liquidity). Everything downstream — the context bias, the
pullback's "is price at a structural area", the liquidity target search — reads
this instead of re-running pivot detection.

Deliberately ignorant of everything else. It knows nothing about volume,
nothing about events, nothing about which timeframe is "context" and which is
"structure". Callers assemble maps per timeframe and combine them.

Bounded by construction: only the most recent `MAX_LEVELS` swings per side are
kept, so a map is cheap to hold for every tracked symbol on every timeframe.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from smc.analysis import compute_pivots
from smc.structure import EqualLevel, MarketStructure, StructureTrend, compute_market_structure
from smc.types import Candle

#: How many swings per side a map retains. Enough for "the next few structural
#: destinations" without holding a symbol's whole history.
MAX_LEVELS = 6

LevelKind = Literal["swing_high", "swing_low", "equal_highs", "equal_lows"]


@dataclass(frozen=True, slots=True)
class StructuralLevel:
    """A price the market has already reacted to.

    `touches` is 1 for a lone swing and the cluster size for an equal-level
    pool — the only quality signal carried, because it is the only one that is
    a fact about the level rather than an opinion about it.
    """

    price: float
    kind: LevelKind
    timeframe: str
    time: int
    touches: int = 1

    @property
    def is_liquidity(self) -> bool:
        """Equal highs/lows are resting liquidity; a lone swing is just a level."""
        return self.kind in ("equal_highs", "equal_lows")


@dataclass(frozen=True, slots=True)
class StructureMap:
    """One timeframe's structural state, reduced to levels."""

    timeframe: str
    trend: StructureTrend
    # Latest structural break on this timeframe: "bos" | "choch" | None.
    event: str | None
    event_label: str | None
    event_time: int
    # Most recent first.
    highs: tuple[StructuralLevel, ...]
    lows: tuple[StructuralLevel, ...]
    last_close: float
    bars: int
    computed_at: float

    @property
    def last_high(self) -> StructuralLevel | None:
        return self.highs[0] if self.highs else None

    @property
    def last_low(self) -> StructuralLevel | None:
        return self.lows[0] if self.lows else None


def _pools(clusters: list[EqualLevel], kind: LevelKind, timeframe: str) -> list[StructuralLevel]:
    out: list[StructuralLevel] = []
    for cluster in clusters:
        if len(cluster.swings) < 2:
            continue
        out.append(
            StructuralLevel(
                price=cluster.price,
                kind=kind,
                timeframe=timeframe,
                time=cluster.swings[-1].time,
                touches=len(cluster.swings),
            )
        )
    return out


def from_structure(
    timeframe: str,
    structure: MarketStructure,
    last_close: float,
    bars: int,
    now: float,
) -> StructureMap:
    """Reduces an already-computed `MarketStructure` to a map.

    Separate from `build_structure_map` so a caller that already needed the
    full structure (the context reader does, for its trend/bias) does not pay
    for pivot detection twice.
    """
    highs = [
        StructuralLevel(price=s.price, kind="swing_high", timeframe=timeframe, time=s.time)
        for s in structure.swings
        if s.kind == "high"
    ]
    lows = [
        StructuralLevel(price=s.price, kind="swing_low", timeframe=timeframe, time=s.time)
        for s in structure.swings
        if s.kind == "low"
    ]
    highs.extend(_pools(structure.equal_highs, "equal_highs", timeframe))
    lows.extend(_pools(structure.equal_lows, "equal_lows", timeframe))
    highs.sort(key=lambda level: -level.time)
    lows.sort(key=lambda level: -level.time)

    swing = structure.event_swing
    return StructureMap(
        timeframe=timeframe,
        trend=structure.trend,
        event=structure.event,
        event_label=swing.label if swing is not None else None,
        event_time=swing.time if swing is not None else 0,
        highs=tuple(highs[:MAX_LEVELS]),
        lows=tuple(lows[:MAX_LEVELS]),
        last_close=last_close,
        bars=bars,
        computed_at=now,
    )


def build_structure_map(timeframe: str, candles: list[Candle], now: float) -> StructureMap | None:
    """Pivots → structure → map, for callers that only want the levels.

    `None` when the series is too short for pivot detection to mean anything;
    the layer stays silent rather than labelling noise.
    """
    if len(candles) < 20:
        return None
    structure = compute_market_structure(compute_pivots(candles))
    return from_structure(timeframe, structure, candles[-1].close, len(candles), now)
