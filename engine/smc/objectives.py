"""Draw-on-liquidity objectives (port of objectives.ts) — "what is price drawn toward?"

A trade's objective is the opposing *weak* structure: the swing high whose
push down failed (long) or the swing low whose push up failed (short) — the
stops resting beyond it are unprotected. Strong swings are defended levels,
protection rather than draw, never a target.

The resolver returns a ranked list of candidates, nearest first. An empty
list is a first-class outcome: "no clean target" is itself the signal (G10),
never papered over with a fabricated level. Derived view, no state. EDR 0008.
"""

from dataclasses import dataclass
from typing import Literal

from smc.liquidity import LiquidityPool
from smc.strength import SwingStrength, derive_swing_strength
from smc.structure import EQUAL_LEVEL_TOLERANCE, MarketStructure, SwingPoint

Direction = Literal["long", "short"]


@dataclass(slots=True)
class ObjectiveCandidate:
    direction: Direction
    # The swing whose resting liquidity is the draw (weak high above / weak low below).
    swing: SwingPoint
    strength: SwingStrength
    # The liquidity line: the coinciding intact pool's price when one exists, else the swing's.
    price: float
    # Intact EQH/EQL pool coinciding with the swing, when the draw is a stacked-stops level.
    pool: LiquidityPool | None


def resolve_objectives(
    structure: MarketStructure,
    pools: list[LiquidityPool],
    direction: Direction,
    from_price: float,
) -> list[ObjectiveCandidate]:
    """Ranked candidate objectives, best first — [0] is the preferred objective.

    Eligibility (EDR 0008, initial and revisable):
    - Only swings strictly beyond from_price in the trade direction.
    - weak qualifies outright; unresolved qualifies too (still targetable,
      merely unproven); strong never qualifies.
    - Untaken only: once a later same-kind swing traded strictly beyond a
      level, the liquidity there is spent.
    - A coinciding intact opposing pool promotes the candidate's price to the
      pool line; each pool is absorbed into at most one candidate, duplicate
      price levels collapse into the pool-backed member.
    """
    kind = "high" if direction == "long" else "low"

    def beyond(a: float, b: float) -> bool:
        return a > b if direction == "long" else a < b

    swings = structure.swings
    entries = derive_swing_strength(structure)
    eligible: list[tuple[SwingPoint, SwingStrength]] = []
    for index, entry in enumerate(entries):
        swing, strength = entry.swing, entry.strength
        if swing.kind != kind or strength == "strong":
            continue
        if not beyond(swing.price, from_price):
            continue
        # Untaken: no later same-kind swing traded strictly beyond this level.
        taken = any(s.kind == kind and beyond(s.price, swing.price) for s in swings[index + 1 :])
        if not taken:
            eligible.append((swing, strength))

    # Pools that could carry a candidate's resting stops: opposing side, still
    # intact, on the target side of from_price. Each is assignable once.
    wanted_side = "bsl" if direction == "long" else "ssl"
    available = [
        p for p in pools if p.side == wanted_side and p.intact and beyond(p.price, from_price)
    ]
    used: set[int] = set()

    # Nearest swing first: the draw is the first liquidity on the path.
    eligible.sort(
        key=lambda e: (
            e[0].price if direction == "long" else -e[0].price,
            e[0].time,
        )
    )

    candidates: list[ObjectiveCandidate] = []
    for swing, strength in eligible:
        # A pool coincides when its line matches the swing within the equality
        # tolerance, or sits between the swing and from_price. Nearest line wins.
        matches = sorted(
            (
                p
                for p in available
                if id(p) not in used
                and (
                    abs(p.price - swing.price) <= swing.price * EQUAL_LEVEL_TOLERANCE
                    or beyond(swing.price, p.price)
                )
            ),
            key=lambda p: abs(p.price - swing.price),
        )
        pool = matches[0] if matches else None
        if pool is not None:
            used.add(id(pool))
        candidates.append(
            ObjectiveCandidate(
                direction=direction,
                swing=swing,
                strength=strength,
                price=pool.price if pool is not None else swing.price,
                pool=pool,
            )
        )

    # One liquidity level is one candidate: duplicates collapse into the
    # pool-backed member, else the earlier swing. Re-sort by the final price —
    # the ranking contract is proximity of the *liquidity line*.
    candidates.sort(
        key=lambda c: (
            c.price if direction == "long" else -c.price,
            1 if c.pool is None else 0,
            c.swing.time,
        )
    )
    seen: set[float] = set()
    out: list[ObjectiveCandidate] = []
    for c in candidates:
        if c.price in seen:
            continue
        seen.add(c.price)
        out.append(c)
    return out
