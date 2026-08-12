"""LIQUIDITY TARGET ENGINE — where could this leg actually go?

A target is a place the market has already shown it cares about: a prior swing,
or a cluster of equal highs/lows where stops are resting. Not a fixed
percentage. "+2% take profit" is a number about the trader; a prior low is a
number about the market, and only the second one tells you whether the path is
worth the risk.

## Ranking

Candidates are levels lying *ahead* of price in the leg's direction, ordered by:

1. **distance** — the nearest untaken destination is the one the next leg has
   to deal with first;
2. **liquidity** — an equal-high/low pool outranks a lone swing at a similar
   distance, because resting orders are what price actually travels toward;
3. **timeframe** — a level that exists on a higher timeframe survives longer.

Levels closer than `min_distance_pct` are ignored: a target inside the noise
band is not a path, it is a rounding error.

Knows nothing about volume, events, context or R-multiples. It answers "what is
in the way", and `structural_path` decides whether that is worth anything.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from smc.structure_map import StructuralLevel, StructureMap

Direction = Literal["bullish", "bearish"]

_EPS = 1e-9

#: Higher is further up the stack when two candidates are otherwise similar.
_TIMEFRAME_RANK: dict[str, int] = {"1m": 0, "3m": 1, "5M": 2, "15M": 3, "1H": 4, "4H": 5}


@dataclass(frozen=True, slots=True)
class TargetConfig:
    # Anything nearer than this is inside the noise band, not a destination.
    min_distance_pct: float = 0.25
    # …and anything past this is a different trade on a different timeframe.
    max_distance_pct: float = 12.0
    # How many candidates to keep. The first is the working target; the rest
    # are the path beyond it.
    max_targets: int = 4
    # Multiplier applied to a liquidity pool's effective distance when ranking.
    # At 0.75 a pool up to a third further away still outranks a lone swing —
    # resting orders are what price actually travels toward.
    liquidity_preference: float = 0.75


DEFAULT_TARGET_CONFIG = TargetConfig()


@dataclass(frozen=True, slots=True)
class Target:
    level: StructuralLevel
    distance_pct: float

    @property
    def price(self) -> float:
        return self.level.price

    @property
    def kind(self) -> str:
        return self.level.kind


def _ahead(direction: Direction, level_price: float, price: float) -> bool:
    """A destination has to be somewhere price has not already gone."""
    return level_price > price if direction == "bullish" else level_price < price


def select_targets(
    maps: tuple[StructureMap, ...],
    direction: Direction,
    price: float,
    config: TargetConfig = DEFAULT_TARGET_CONFIG,
) -> tuple[Target, ...]:
    """Ranked structural destinations ahead of `price`, nearest-first.

    Empty when nothing lies ahead within range — which is a real answer, and
    the one that stops a situation being surfaced with an invented target.
    """
    if price <= _EPS:
        return ()

    seen: set[tuple[str, int]] = set()
    scored: list[tuple[float, int, Target]] = []
    for structure_map in maps:
        levels = structure_map.highs if direction == "bullish" else structure_map.lows
        for level in levels:
            if not _ahead(direction, level.price, price):
                continue
            distance = abs(level.price - price) / price * 100.0
            if distance < config.min_distance_pct or distance > config.max_distance_pct:
                continue
            # Two timeframes often see the same level; keep the higher one.
            key = (level.kind, round(level.price / price * 10_000))
            if key in seen:
                continue
            seen.add(key)
            effective = distance * (config.liquidity_preference if level.is_liquidity else 1.0)
            rank = -_TIMEFRAME_RANK.get(level.timeframe, 0)
            scored.append((effective, rank, Target(level=level, distance_pct=round(distance, 3))))

    scored.sort(key=lambda row: (row[0], row[1], row[2].level.price))
    return tuple(row[2] for row in scored[: config.max_targets])


def detect_sweep(
    maps: tuple[StructureMap, ...],
    direction: Direction,
    pullback_extreme: float,
    price: float,
) -> StructuralLevel | None:
    """The level a retracement ran through and then gave back, if any.

    A sweep is two facts, not one: price went *beyond* resting liquidity, and
    it is no longer there. Both are required — trading through a level and
    staying above it is a breakout, which is the opposite reading.

    The levels searched are on the retracement's side: a bearish impulse
    retraces up into buy-side liquidity (equal highs), and vice versa.
    """
    if price <= _EPS:
        return None
    best: StructuralLevel | None = None
    for structure_map in maps:
        # Bearish leg retraces upward, so the liquidity it can sweep is above.
        levels = structure_map.highs if direction == "bearish" else structure_map.lows
        for level in levels:
            if not level.is_liquidity or level.price <= _EPS:
                continue
            if direction == "bearish":
                swept = pullback_extreme > level.price and price < level.price
            else:
                swept = pullback_extreme < level.price and price > level.price
            if not swept:
                continue
            # Prefer the deepest one taken.
            if best is None or (
                level.price > best.price if direction == "bearish" else level.price < best.price
            ):
                best = level
    return best
