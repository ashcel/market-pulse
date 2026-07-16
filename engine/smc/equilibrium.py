"""Dealing range and equilibrium (port of equilibrium.ts) — premium/discount.

The range runs from the most recent *strong* swing (the last level the market
actually defended) to the most extreme opposite swing printed since it. Its
midpoint is equilibrium; above it price is at a premium, below at a discount.
The SMC entry gate: longs are bought at a discount, shorts sold at a premium.

Derived view over a computed structure, no state of its own. Absence is a
first-class outcome, never fabricated from unproven swings. See EDR 0005.
"""

from dataclasses import dataclass
from typing import Literal

from smc.strength import derive_swing_strength
from smc.structure import MarketStructure, SwingPoint

PricePosition = Literal["premium", "discount", "equilibrium"]


@dataclass(slots=True)
class DealingRange:
    # The range floor. When anchor is "low", this is the strong swing itself.
    low: SwingPoint
    # The range ceiling. When anchor is "high", this is the strong swing itself.
    high: SwingPoint
    # Which side is the defended (strong) swing the range is anchored to.
    anchor: Literal["low", "high"]
    # The midpoint of the range — the premium/discount boundary.
    equilibrium: float


def compute_dealing_range(structure: MarketStructure) -> DealingRange | None:
    """Anchor at the most recent strong swing (of either kind — pairing the last
    strong low with the last strong high can invert in a trend), then take the
    most extreme opposite-kind swing printed after it. None when no swing is
    strong yet or nothing has printed beyond the anchor."""
    entries = derive_swing_strength(structure)
    anchor_index = -1
    for i in range(len(entries) - 1, -1, -1):
        if entries[i].strength == "strong":
            anchor_index = i
            break
    if anchor_index == -1:
        return None

    anchor = structure.swings[anchor_index]
    extreme: SwingPoint | None = None
    for swing in structure.swings[anchor_index + 1 :]:
        if swing.kind == anchor.kind:
            continue
        # Strict comparison keeps the earlier swing on a tie — deterministic.
        if extreme is None or (
            swing.price > extreme.price if anchor.kind == "low" else swing.price < extreme.price
        ):
            extreme = swing
    if extreme is None:
        return None

    low = anchor if anchor.kind == "low" else extreme
    high = extreme if anchor.kind == "low" else anchor
    if low.price >= high.price:
        return None

    return DealingRange(
        low=low, high=high, anchor=anchor.kind, equilibrium=(low.price + high.price) / 2
    )


def classify_price(range_: DealingRange, price: float) -> PricePosition:
    """Where a price sits in the range. Exact midpoint reads "equilibrium" —
    deliberately no tolerance band (a band is a tunable this layer ships none of)."""
    if price > range_.equilibrium:
        return "premium"
    if price < range_.equilibrium:
        return "discount"
    return "equilibrium"
