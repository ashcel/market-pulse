"""PULLBACK DETECTOR — is this impulse retracing, or is it over?

One question, answered from price geometry and the pullback's own flow. It
knows nothing about higher-timeframe bias, nothing about events, and nothing
about whether the pullback is *ending* (that is
`pullback_completion.py`). Keeping it that narrow is what lets the evidence
downstream stay inspectable: every field here is a measurement, not a verdict.

## What counts as a pullback

Not "a candle went the other way". A retracement has to be *material* relative
to the impulse that produced it — `min_retrace_frac` of the leg — which is why
depth is always expressed as a fraction of the leg rather than a raw
percentage: 1% back on a 2% leg is a failure, 1% back on a 12% leg is a pause.

Past `max_retrace_frac` the read becomes DEEP (still alive, but the structure
is stretched), and once price trades back through the impulse origin the leg is
BROKEN — there is no longer an impulse to continue.

## Health, separately

`is_healthy` is not a gate and does not change the state. A pullback that
retraces on rising volume against the leg is still a pullback; it is just a bad
one, and the fields say so individually so a caller can show *why*.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from smc.structure_map import StructuralLevel

Direction = Literal["bullish", "bearish"]
PullbackState = Literal["NONE", "PULLBACK", "DEEP", "BROKEN"]

_EPS = 1e-9


@dataclass(frozen=True, slots=True)
class PullbackConfig:
    """Thresholds for one trading mode. Scalp and intraday deliberately differ:
    a scalper's pullback is shallower and shorter-lived than an intraday
    trader's, and forcing one set of numbers on both is how a scanner ends up
    useless for either."""

    # Depth, as a fraction of the impulse leg.
    min_retrace_frac: float = 0.20
    healthy_retrace_frac: float = 0.50
    max_retrace_frac: float = 0.75
    # Relative volume during the retracement. At or below this, the pullback is
    # cooling — the classic "supply drying up" read, measured rather than named.
    cooling_rvol: float = 1.00
    # A counter-move this large on this much volume is not a pullback any more.
    opposing_move_pct: float = 0.90
    opposing_rvol: float = 2.00
    # How close (in %) price must be to a level to count as "at" it.
    poi_proximity_pct: float = 0.35

    def __post_init__(self) -> None:
        if not 0.0 < self.min_retrace_frac < self.max_retrace_frac:
            raise ValueError("min_retrace_frac must be positive and below max_retrace_frac")


DEFAULT_PULLBACK_CONFIG = PullbackConfig()


@dataclass(frozen=True, slots=True)
class ImpulseLeg:
    """The move being retraced. `origin` is where it started, `extreme` the
    furthest it travelled in `direction`."""

    direction: Direction
    origin: float
    extreme: float
    started_at: float

    @property
    def size(self) -> float:
        return abs(self.extreme - self.origin)

    @property
    def size_pct(self) -> float:
        base = min(abs(self.origin), abs(self.extreme))
        return self.size / base * 100.0 if base > _EPS else 0.0


@dataclass(frozen=True, slots=True)
class PullbackRead:
    """Everything measurable about the current retracement.

    Every field is a measurement with a unit, so a card can show the ones that
    matter and a test can assert on them without re-deriving anything.
    """

    state: PullbackState
    # Depth as a fraction of the impulse leg (0 at the extreme, 1.0 at origin).
    retrace_frac: float
    # …and as a plain percentage move, which is what a human reads.
    retrace_pct: float
    # The furthest price has travelled back, in price terms.
    pullback_extreme: float
    duration_seconds: float
    # Relative volume during the retracement; < 1 means the tape is cooling.
    volume_ratio: float | None
    # Counter-directional move on the fast window, as a positive magnitude.
    opposing_move_pct: float
    # False once price has traded back through the impulse origin.
    structure_intact: bool
    # Nearest structural level price is sitting on, if any.
    at_level: StructuralLevel | None
    distance_to_level_pct: float | None

    @property
    def is_active(self) -> bool:
        return self.state in ("PULLBACK", "DEEP")

    @property
    def is_healthy(self) -> bool:
        """Display-only: shallow, cooling, structurally intact, nothing pushing
        hard the other way. Never gates a transition."""
        return (
            self.state == "PULLBACK"
            and self.structure_intact
            and self.retrace_frac <= 0.55
            and (self.volume_ratio is None or self.volume_ratio <= 1.2)
        )


def retrace_fraction(leg: ImpulseLeg, price: float) -> float:
    """How much of the leg has been given back. 0.0 at the extreme, 1.0 back at
    the origin, >1.0 through it."""
    if leg.size <= _EPS:
        return 0.0
    travelled = (leg.extreme - price) if leg.direction == "bullish" else (price - leg.extreme)
    return max(0.0, travelled / leg.size)


def nearest_level(
    levels: tuple[StructuralLevel, ...] | list[StructuralLevel],
    price: float,
) -> tuple[StructuralLevel | None, float | None]:
    """Closest level to `price`, and how far away it is in percent."""
    best: StructuralLevel | None = None
    best_distance: float | None = None
    for level in levels:
        if level.price <= _EPS:
            continue
        distance = abs(level.price - price) / price * 100.0 if price > _EPS else 0.0
        if best_distance is None or distance < best_distance:
            best = level
            best_distance = distance
    return best, best_distance


def read_pullback(
    leg: ImpulseLeg,
    price: float,
    *,
    pullback_extreme: float,
    now: float,
    started_at: float | None = None,
    volume_ratio: float | None = None,
    opposing_move_pct: float = 0.0,
    levels: tuple[StructuralLevel, ...] = (),
    config: PullbackConfig = DEFAULT_PULLBACK_CONFIG,
) -> PullbackRead:
    """Measures the retracement. Pure, total, and free of opinions.

    `pullback_extreme` is the deepest counter-travel the caller has observed
    since the impulse extreme — tracked outside because it is a running
    maximum, and this function has no memory by design.

    `levels` are the structural levels retracement could be reaching into; the
    caller decides which timeframes to offer (a scalper's 5m swings, an
    intraday trader's 15m ones).
    """
    fraction = retrace_fraction(leg, price)
    deepest = retrace_fraction(leg, pullback_extreme)
    depth = max(fraction, deepest)

    base = price if price > _EPS else 1.0
    retrace_pct = abs(price - leg.extreme) / base * 100.0

    structure_intact = depth < 1.0
    if not structure_intact:
        state: PullbackState = "BROKEN"
    elif depth >= config.max_retrace_frac:
        state = "DEEP"
    elif depth >= config.min_retrace_frac:
        state = "PULLBACK"
    else:
        state = "NONE"

    level, distance = nearest_level(levels, price)
    if distance is not None and distance > config.poi_proximity_pct:
        level = None

    return PullbackRead(
        state=state,
        retrace_frac=round(depth, 4),
        retrace_pct=round(retrace_pct, 3),
        pullback_extreme=pullback_extreme,
        duration_seconds=max(0.0, now - started_at) if started_at is not None else 0.0,
        volume_ratio=None if volume_ratio is None else round(volume_ratio, 2),
        opposing_move_pct=round(max(0.0, opposing_move_pct), 3),
        structure_intact=structure_intact,
        at_level=level,
        distance_to_level_pct=None if distance is None else round(distance, 3),
    )
