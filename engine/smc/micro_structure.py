"""MICRO STRUCTURE — 1m CHoCH / BOS from the realtime tick buffer.

The fast lane's trigger context. Where `market_context` reads 4H/1H/15m closed
candles on a slow timer, this reads *one-minute* candles rebuilt from the
radar's own in-memory price buffer (`app.momentum.state`), so a structure break
is available seconds after it prints rather than at the next 5m close.

It reuses the same swing/structure engine as every other structural read in the
codebase (`compute_pivots` + `compute_market_structure`) — this module only
decides what counts as *new*.

Deliberately narrow, like every other detector here: it knows nothing about
volume, relative volume or momentum scores. It reports "the 1m structure just
flipped, this way, at this time" and stops. Combining that with anything else
is `context_alignment`'s job, not this module's.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from smc.analysis import compute_pivots
from smc.structure import StructureTrend, compute_market_structure
from smc.types import Candle

MicroDirection = Literal["bullish", "bearish"]

#: Fewest 1m candles before a structure read means anything. Below this the
#: pivot window is wider than the series and every read would be noise.
MIN_MICRO_CANDLES = 20


@dataclass(frozen=True, slots=True)
class MicroStructureRead:
    """The 1m structure at one instant."""

    trend: StructureTrend
    # "choch" (a break against the prevailing structure) | "bos" | None.
    event: str | None
    # Candle time of the swing that produced the break — the identity used to
    # decide whether a later read is the *same* break or a new one.
    event_time: int
    direction: MicroDirection | None
    bars: int


def read_micro_structure(candles: list[Candle]) -> MicroStructureRead | None:
    """Structure read over 1m candles, or `None` when there is too little
    tape. Callers pass closed minutes only."""
    if len(candles) < MIN_MICRO_CANDLES:
        return None

    structure = compute_market_structure(compute_pivots(candles))
    swing = structure.event_swing
    direction: MicroDirection | None = None
    if swing is not None and swing.label is not None:
        direction = "bullish" if swing.label in ("HH", "HL") else "bearish"
    return MicroStructureRead(
        trend=structure.trend,
        event=structure.event,
        event_time=swing.time if swing is not None else 0,
        direction=direction,
        bars=len(candles),
    )


def is_new_break(
    previous: MicroStructureRead | None,
    current: MicroStructureRead | None,
    *,
    choch_only: bool = True,
) -> bool:
    """True when `current` carries a structural break the caller has not seen.

    Identity is the swing's candle time, not the event kind: re-reading the
    same CHoCH on the next tick must not mint a second event, which is the
    whole reason this comparison exists rather than "did event != None".
    """
    if current is None or current.event is None or current.direction is None:
        return False
    if choch_only and current.event != "choch":
        return False
    if previous is None:
        return True
    return current.event_time != previous.event_time or current.event != previous.event
