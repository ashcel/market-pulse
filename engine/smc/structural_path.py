"""STRUCTURAL PATH — entry zone, invalidation, target, and the ratio between.

Given where a continuation would start, where it would be structurally wrong,
and where it could go, this computes the geometry:

    Entry: 0.421 · Invalidation: 0.428 · Target: 0.379 → 5.8R

## R is a filter, not a blessing

A high ratio means the *path* is asymmetric. It says nothing about whether the
move happens, and this module never claims otherwise: the verdict vocabulary is
`SKIP` / `THIN` / `WORTH_WATCHING`, with no "entry", "long" or "short" anywhere
in it. Its job in the funnel is to remove situations whose structure leaves no
room — which is a *reduction* of the candidate set, the only thing a layer here
is allowed to do.

Invalidation comes from structure too: just beyond the pullback's own extreme,
where the retracement would have to be wrong. The buffer is a fraction of the
impulse leg rather than a fixed percentage, so it scales with the move.

## Why the stop has a volatility floor

A structural stop can be *arithmetically* correct and still worthless: if it
lands inside the symbol's own one-minute range, ordinary noise takes it out
before the thesis has a chance to be right or wrong. Worse, because
`RR = reward / risk`, a stop inside the noise band inflates R — so an `min_rr`
gate applied to raw geometry actively **selects for** the thinnest, most
fragile stops. The first forward-test cohort showed exactly that: a median
0.25% stop, a median 55 seconds to invalidation, and advertised ratios up to
14R on trades that never moved in favour at all.

The floor breaks that loop. Risk must be at least `min_risk_volatility_mult`
times the symbol's baseline 1m range (and at least `min_risk_pct` outright), so
a wider stop *lowers* the ratio instead of raising it, and the RR gate stops
rewarding degenerate geometry.

## …and why it has to be measured from the entry

The floor is a statement about **risk**, so it has to constrain the distance
from *entry* to invalidation. Applying it to the buffer beyond the pullback
extreme — which is what this module did through generation 4 — only bounds one
leg of that distance, and leaves it free to shrink whenever entry sits between
the extreme and the invalidation. It did: 11 of 90 generation-4 records came in
under their own mode's floor, one INTRADAY setup at 0.175% against a 0.60%
floor, and the thinnest stops still carried the highest advertised ratios
(0.350% risk at 11.6R). The loop the floor was written to break was still
running, one level down.

## The second floor: cost

Noise is not the only thing that can be wider than a stop. A round trip costs
`round_trip_cost_pct` of *price* while risk is measured against the stop, so
cost as a fraction of R is `round_trip_cost_pct / risk_pct` — and it explodes
exactly where the geometry is thinnest. Generation 4 paid a median 0.225R and a
maximum 0.802R in fees, 21.4R over 85 trades, against a gross edge of 17.2R.
The trade was directionally right slightly more often than not and still lost,
because the stop was never wide enough to be worth crossing the spread for.

`max_cost_r` states the budget — cost may consume at most this fraction of risk
— and the floor derives the minimum stop from it. This is arithmetic known at
detection, not an outcome filter: no record has to settle for it to be true.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Direction = Literal["bullish", "bearish"]
PathVerdict = Literal["SKIP", "THIN", "WORTH_WATCHING"]

_EPS = 1e-9


@dataclass(frozen=True, slots=True)
class PathConfig:
    """Per-mode geometry. A scalper tolerates a tighter path than an intraday
    trader, but both reject one with no room in it."""

    # Invalidation sits this fraction of the impulse leg beyond the pullback
    # extreme — scaled to the move rather than a flat percentage.
    invalidation_buffer_frac: float = 0.12
    # …with a floor, so a tiny leg does not produce a zero-width stop.
    min_invalidation_pct: float = 0.15
    # …and a *volatility* floor, which is the one that matters: the stop must
    # clear this many multiples of the symbol's baseline 1m range, or noise
    # settles the trade before the thesis does.
    min_risk_volatility_mult: float = 1.5
    # An absolute floor for symbols whose volatility read is missing.
    min_risk_pct: float = 0.35
    # …and a *cost* floor. A round trip costs this much of price, and it may
    # eat at most `max_cost_r` of the risk — which sets a minimum stop width of
    # `round_trip_cost_pct / max_cost_r` outright. Keep the cost in step with
    # `ForwardTestConfig`: it is the same round trip, stated where the geometry
    # is decided rather than where it is settled.
    round_trip_cost_pct: float = 0.14
    max_cost_r: float = 0.25
    # Below this the path is not worth the risk; between the two it is thin.
    min_rr: float = 1.8
    good_rr: float = 3.0

    def __post_init__(self) -> None:
        if self.min_rr > self.good_rr:
            raise ValueError("min_rr must not exceed good_rr")
        if not 0.0 < self.max_cost_r <= 1.0:
            raise ValueError("max_cost_r must be in (0, 1]")
        if self.round_trip_cost_pct < 0.0:
            raise ValueError("round_trip_cost_pct cannot be negative")

    @property
    def cost_floor_pct(self) -> float:
        """Minimum stop width at which cost stays inside its budget."""
        return self.round_trip_cost_pct / self.max_cost_r


DEFAULT_PATH_CONFIG = PathConfig()


def risk_floor_pct(
    config: PathConfig = DEFAULT_PATH_CONFIG,
    volatility_pct: float | None = None,
) -> float:
    """The narrowest stop this mode will accept, as a percentage of price.

    Three independent reasons a stop can be too tight, and the binding one
    wins: it sits inside the symbol's own noise, it is below the absolute
    floor, or cost would eat more of it than the budget allows.
    """
    return max(
        config.min_invalidation_pct,
        config.min_risk_pct,
        config.cost_floor_pct,
        (volatility_pct or 0.0) * config.min_risk_volatility_mult,
    )


@dataclass(frozen=True, slots=True)
class StructuralPath:
    direction: Direction
    entry: float
    invalidation: float
    target: float
    # Absolute distances, and the same in percent of entry.
    risk: float
    reward: float
    risk_pct: float
    reward_pct: float
    rr: float
    verdict: PathVerdict
    # What the target actually is ("equal_lows", "swing_high", …).
    target_kind: str = ""

    @property
    def is_worth_watching(self) -> bool:
        return self.verdict == "WORTH_WATCHING"


def invalidation_price(
    direction: Direction,
    pullback_extreme: float,
    leg_size: float,
    config: PathConfig = DEFAULT_PATH_CONFIG,
    volatility_pct: float | None = None,
) -> float:
    """Just beyond the pullback's own extreme: the price at which the
    retracement stops being a retracement.

    Sides matter and are easy to get backwards: a *bearish* leg retraces
    **up**, so its invalidation sits above the retracement high; a bullish leg
    retraces down, so its invalidation sits below the retracement low.
    """
    buffer = max(
        leg_size * config.invalidation_buffer_frac,
        abs(pullback_extreme) * risk_floor_pct(config, volatility_pct) / 100.0,
    )
    return pullback_extreme - buffer if direction == "bullish" else pullback_extreme + buffer


def build_path(
    direction: Direction,
    *,
    entry: float,
    pullback_extreme: float,
    leg_size: float,
    target: float,
    target_kind: str = "",
    config: PathConfig = DEFAULT_PATH_CONFIG,
    volatility_pct: float | None = None,
) -> StructuralPath | None:
    """Assembles the path. `None` when the geometry is degenerate — no risk
    distance, or a target that is not actually ahead of entry.

    Pure arithmetic over prices the caller already derived from structure; this
    module never goes looking for a target of its own.
    """
    if entry <= _EPS:
        return None
    invalidation = invalidation_price(direction, pullback_extreme, leg_size, config, volatility_pct)

    # The floor is a claim about *risk*, so it is enforced here, against the
    # entry — placing the invalidation beyond the pullback extreme bounds only
    # one leg of that distance and leaves the rest free to collapse whenever
    # entry sits inside the buffer. Widening here can only lower `rr`, which is
    # the direction that keeps the `min_rr` gate honest.
    min_risk = entry * risk_floor_pct(config, volatility_pct) / 100.0
    if abs(invalidation - entry) < min_risk:
        invalidation = entry - min_risk if direction == "bullish" else entry + min_risk

    risk = abs(invalidation - entry)
    reward = abs(target - entry)
    if risk <= _EPS or reward <= _EPS:
        return None
    # The target has to be on the other side of entry from the invalidation.
    if direction == "bullish" and not (target > entry and invalidation < entry):
        return None
    if direction == "bearish" and not (target < entry and invalidation > entry):
        return None

    rr = reward / risk
    if rr < config.min_rr:
        verdict: PathVerdict = "SKIP"
    elif rr < config.good_rr:
        verdict = "THIN"
    else:
        verdict = "WORTH_WATCHING"

    return StructuralPath(
        direction=direction,
        entry=entry,
        invalidation=invalidation,
        target=target,
        risk=risk,
        reward=reward,
        risk_pct=round(risk / entry * 100.0, 3),
        reward_pct=round(reward / entry * 100.0, 3),
        rr=round(rr, 2),
        verdict=verdict,
        target_kind=target_kind,
    )
