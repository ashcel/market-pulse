"""POI selection and the anticipatory limit plan (port of poi.ts) — the
Dreimann entry model.

Instead of acting at the live price, the trader rests a limit at a point of
interest below it (a demand zone for longs; supply mirror), stop beyond the
zone's wick extreme, target at the draw-on-liquidity objective. RR is measured
from the *limit price*, not from where price trades now (risk R4).

In Phase 1 a POI is a BaseZone; the OB/FVG/zone unification widens the input
type without reshaping consumers. Pure derivation, no state. EDR 0009.
"""

from dataclasses import dataclass

from smc.equilibrium import DealingRange, PricePosition, classify_price
from smc.objectives import Direction, ObjectiveCandidate
from smc.zones import BaseZone


@dataclass(slots=True)
class AnticipatoryPlan:
    direction: Direction
    # The POI the limit rests at.
    zone: BaseZone
    # Proximal edge — where the limit fills first.
    entry: float
    # Beyond the distal edge: the zone's full wick extreme, no buffer (see EDR).
    stop: float
    # The preferred objective (objectives[0]): no objective -> no plan (G10's shape).
    objective: ObjectiveCandidate
    risk_per_unit: float
    reward_per_unit: float
    reward_risk: float
    # Where the entry sits in the timeframe's dealing range; None when no range exists.
    entry_position: PricePosition | None


def _proximal_edge(zone: BaseZone, direction: Direction) -> float:
    """The zone edge a resting limit fills at first."""
    return zone.price_high if direction == "long" else zone.price_low


def select_poi(
    zones: list[BaseZone],
    direction: Direction,
    from_price: float,
    range_: DealingRange | None,
) -> BaseZone | None:
    """Pick the POI a limit entry would rest at.

    Among zones of the entry kind whose proximal edge is at or beyond
    from_price in the pullback direction: prefer discount-side of the dealing
    range first (premium mirror for shorts), then fresh over tested, then the
    nearest proximal edge. No range -> the position preference drops out.
    """
    kind = "demand" if direction == "long" else "supply"
    wanted_side: PricePosition = "discount" if direction == "long" else "premium"

    def on_wanted_side(zone: BaseZone) -> int:
        return (
            0
            if range_ is not None
            and classify_price(range_, _proximal_edge(zone, direction)) == wanted_side
            else 1
        )

    candidates = [
        zone
        for zone in zones
        if zone.kind == kind
        and (
            _proximal_edge(zone, direction) <= from_price
            if direction == "long"
            else _proximal_edge(zone, direction) >= from_price
        )
    ]

    candidates.sort(
        key=lambda z: (
            on_wanted_side(z),
            0 if z.freshness == "fresh" else 1,
            -_proximal_edge(z, direction) if direction == "long" else _proximal_edge(z, direction),
            z.start_time,
        )
    )
    return candidates[0] if candidates else None


def build_anticipatory_plan(
    zones: list[BaseZone],
    direction: Direction,
    from_price: float,
    range_: DealingRange | None,
    objectives: list[ObjectiveCandidate],
) -> AnticipatoryPlan | None:
    """The full anticipatory read: limit at the selected POI's proximal edge,
    stop at its distal edge (the full wick extreme — the ZEC-SL lesson; no ATR
    buffer), target at the **preferred** objective. None when no objective
    candidate exists, no zone qualifies, or the geometry isn't strictly
    positive (entry strictly between stop and objective)."""
    if not objectives:
        return None
    objective = objectives[0]
    zone = select_poi(zones, direction, from_price, range_)
    if zone is None:
        return None

    entry = _proximal_edge(zone, direction)
    stop = zone.price_low if direction == "long" else zone.price_high
    risk_per_unit = entry - stop if direction == "long" else stop - entry
    reward_per_unit = objective.price - entry if direction == "long" else entry - objective.price
    if risk_per_unit <= 0 or reward_per_unit <= 0:
        return None

    return AnticipatoryPlan(
        direction=direction,
        zone=zone,
        entry=entry,
        stop=stop,
        objective=objective,
        risk_per_unit=risk_per_unit,
        reward_per_unit=reward_per_unit,
        reward_risk=reward_per_unit / risk_per_unit,
        entry_position=None if range_ is None else classify_price(range_, entry),
    )
