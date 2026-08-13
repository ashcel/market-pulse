"""SWING PLAN — the same detection, measured against slow structure.

The fast lane finds a moment. This asks a different question about that same
moment: **if the plan came from the 4H/1H structure instead of from the impulse
leg, would it have been worth more?**

## Why this is a plan and not a longer clock

A momentum event's stop and target are derived from the leg that produced it —
the pullback extreme just behind, the next liquidity pool just ahead. Both are
minutes wide. Simply holding that plan for hours does not make it a swing: it
holds a fast hypothesis past the thing that generated it, and the stop still
sits inside the noise of a timeframe it was never measured on.

A swing plan re-anchors both ends on structure the slow lane already computed:

* **invalidation** — the nearest opposing slow swing *behind* entry, the level
  that would have to break for the read to be wrong on that timeframe;
* **target** — the next slow structural level ahead, chosen by the same
  `liquidity_targets` rules the fast lane uses, just on slower maps.

Everything else about the hypothesis is unchanged: same symbol, same instant,
same direction, same entry price. That is deliberate. Held against the fast
plan as a forward-test variant, the *only* difference is the geometry, so the
comparison answers the geometry question and nothing else.

## What it cannot tell you

It cannot say whether the direction was right — that is the detector's claim,
and both plans inherit it. It says whether a wider, structurally-anchored stop
and a further target convert the same read into more R than a tight one. Given
that cost is `round_trip_pct / risk_pct`, a wider stop starts with a real
arithmetic advantage and still has to earn the rest.

No decision here. Returns a path or `None`, never a verdict to act on.
"""

from __future__ import annotations

from typing import Literal

from smc.liquidity_targets import DEFAULT_TARGET_CONFIG, TargetConfig, select_targets
from smc.structural_path import (
    DEFAULT_PATH_CONFIG,
    PathConfig,
    StructuralPath,
    build_path,
)
from smc.structure_map import StructureMap

SWING_PLAN_VERSION = "1.0.0"

Direction = Literal["bullish", "bearish"]


def structural_anchor(
    direction: Direction,
    entry: float,
    maps: tuple[StructureMap, ...],
) -> float | None:
    """The nearest slow level behind entry that would have to break.

    Nearest, not furthest: the closest structural level still *behind* price is
    the first one whose loss changes the read. Anchoring on a distant one would
    quietly buy a wider stop by ignoring the structure in between, which is the
    same self-flattery as a stop inside the noise band, pointed the other way.

    `None` when structure offers nothing behind price — no anchor is a reason
    to have no plan, never a reason to invent a percentage.
    """
    best: float | None = None
    for structure in maps:
        levels = structure.lows if direction == "bullish" else structure.highs
        for level in levels:
            if direction == "bullish":
                if level.price >= entry:
                    continue
                if best is None or level.price > best:
                    best = level.price
            else:
                if level.price <= entry:
                    continue
                if best is None or level.price < best:
                    best = level.price
    return best


def swing_plan(
    direction: Direction,
    entry: float,
    maps: tuple[StructureMap, ...],
    *,
    config: PathConfig = DEFAULT_PATH_CONFIG,
    targets_config: TargetConfig = DEFAULT_TARGET_CONFIG,
) -> StructuralPath | None:
    """The slow-structure plan for a fast detection, or `None`.

    `None` is the common and correct answer: most fast events fire on symbols
    whose slow structure has no level behind price, no level ahead, or a
    ratio too short to be worth anything. A plan that cannot be built is not
    a failure to record — it is the honest statement that this moment had no
    swing thesis behind it.
    """
    if entry <= 0.0 or not maps:
        return None
    anchor = structural_anchor(direction, entry, maps)
    if anchor is None:
        return None
    targets = select_targets(maps, direction, entry, targets_config)
    if not targets:
        return None
    return build_path(
        direction,
        entry=entry,
        pullback_extreme=anchor,
        leg_size=abs(entry - anchor),
        target=targets[0].price,
        target_kind=targets[0].kind,
        config=config,
    )
