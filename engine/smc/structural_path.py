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
    # Below this the path is not worth the risk; between the two it is thin.
    min_rr: float = 1.8
    good_rr: float = 3.0

    def __post_init__(self) -> None:
        if self.min_rr > self.good_rr:
            raise ValueError("min_rr must not exceed good_rr")


DEFAULT_PATH_CONFIG = PathConfig()


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
    noise = (volatility_pct or 0.0) * config.min_risk_volatility_mult
    floor_pct = max(config.min_invalidation_pct, config.min_risk_pct, noise)
    buffer = max(
        leg_size * config.invalidation_buffer_frac,
        abs(pullback_extreme) * floor_pct / 100.0,
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
    invalidation = invalidation_price(
        direction, pullback_extreme, leg_size, config, volatility_pct
    )

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
