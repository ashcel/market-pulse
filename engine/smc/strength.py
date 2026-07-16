"""Strong vs. weak swings (port of strength.ts) — the SMC read behind
objective selection.

A swing high whose decline broke structure (its own pullback leg took out the
swing low that preceded it) is *strong*: the market defended it. A swing high
whose decline failed to break that low is *weak*: the liquidity resting above
it is the draw — it is a target. Mirror for lows.

Strength is inherently forward-looking, so it can never be a stored SwingPoint
field without breaking the structure engine's frozen-record invariant. This
module only *derives* a view over a computed MarketStructure at read time —
replay-safe by construction. See EDR 0004.
"""

from dataclasses import dataclass
from typing import Literal

from smc.structure import MarketStructure, SwingPoint

SwingStrength = Literal["strong", "weak", "unresolved"]


@dataclass(slots=True)
class SwingStrengthEntry:
    # The same object held in structure.swings — join by identity.
    swing: SwingPoint
    strength: SwingStrength
    # The swing's own counter-leg — the opposite-kind swing right after it,
    # whose verdict this is. None while no counter-leg exists.
    judged_by: SwingPoint | None


def derive_swing_strength(structure: MarketStructure) -> list[SwingStrengthEntry]:
    """Derive the strength of every swing, in swings order.

    - strong: the counter-leg trades strictly beyond the preceding opposite
      swing — decidable while the leg is still forming (a break can't un-happen).
    - weak: the counter-leg *completes* without that break (the next same-kind
      swing exists, freezing the leg's extreme) — final too.
    - unresolved: counter-leg absent or still forming without a break.

    Strict inequalities throughout, consistent with structure.ts's HH/LL rule.
    """
    swings = structure.swings
    entries: list[SwingStrengthEntry] = []
    for index, swing in enumerate(swings):
        prior = swings[index - 1] if index > 0 else None
        counter_leg = swings[index + 1] if index + 1 < len(swings) else None
        if prior is None or counter_leg is None:
            entries.append(SwingStrengthEntry(swing=swing, strength="unresolved", judged_by=None))
            continue

        broke = (
            counter_leg.price < prior.price
            if swing.kind == "high"
            else counter_leg.price > prior.price
        )
        if broke:
            entries.append(
                SwingStrengthEntry(swing=swing, strength="strong", judged_by=counter_leg)
            )
            continue

        leg_completed = index + 2 < len(swings)
        entries.append(
            SwingStrengthEntry(swing=swing, strength="weak", judged_by=counter_leg)
            if leg_completed
            else SwingStrengthEntry(swing=swing, strength="unresolved", judged_by=None)
        )
    return entries
