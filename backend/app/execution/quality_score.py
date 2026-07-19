"""Trade Quality Score — M9-T4 (EDR 0020 decision 5).

Deterministic 0-100 evaluation of a trade proposal's rule-compliance and
setup quality. **Not a win-probability** — see `SCORE_DISCLAIMER` below,
which every render site (M9-T4 DoD) must carry verbatim or in close
paraphrase. The AI CRO may explain this score; it never generates, adjusts,
or re-weights it (EDR 0020 decision 5) — this module has no AI/LLM
dependency of any kind.

Pure math only: no DB, no network, no clock, no randomness. Identical
`TradeQualityInput` always produces an identical `TradeQualityScore`. The
input dataclass is deliberately "light" — already-derived ratios/percentages/
enums/booleans, never raw candles, prices, or account objects — so this
module stays decoupled from `sizing.py`, `risk_engine.py`, and any live data
source. Those modules (owned separately) may compute inputs for this one to
consume; they are not imported here.

Component weights (sum to 100 — asserted by the test suite):

    risk_reward            25   R:R vs the constitution's configured minimum
    stop_placement          20   stop anchored to real structure, not arbitrary
    constitution_headroom  15   remaining daily/weekly/position/exposure room
    volatility_vs_stop     15   stop distance sane relative to current volatility
    session_liquidity      10   trading in an allowed, liquid session window
    behavior_flags         15   deterministic behavior-detector flags present

Full rationale for each component's shape lives in
`docs/trade-quality-score.md` — keep that doc and this module's constants in
sync if either changes.
"""

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

from .constants import KNOWN_BEHAVIOR_DETECTORS

# ---------------------------------------------------------------------------
# The label every render site must carry (EDR 0020 decision 5 / M0
# score-honesty rules). Defined once here so downstream schemas/UI reuse this
# exact string instead of ad hoc phrasing — see docs/score-inventory.md.
# ---------------------------------------------------------------------------
SCORE_DISCLAIMER: Final[str] = (
    "Evaluation of rule-compliance and setup quality — not a win-probability."
)

TQS_MIN: Final[float] = 0.0
TQS_MAX: Final[float] = 100.0


class QualityComponent(StrEnum):
    """Typed component names, not free text — mirrors the permit's
    enumerated-reasons convention (EDR 0020 decision 6)."""

    RISK_REWARD = "risk_reward"
    STOP_PLACEMENT = "stop_placement"
    CONSTITUTION_HEADROOM = "constitution_headroom"
    VOLATILITY_VS_STOP = "volatility_vs_stop"
    SESSION_LIQUIDITY = "session_liquidity"
    BEHAVIOR_FLAGS = "behavior_flags"


# Weights — the only place these numbers are defined. `docs/trade-quality-score.md`
# must quote these verbatim.
WEIGHT_RISK_REWARD: Final[float] = 25.0
WEIGHT_STOP_PLACEMENT: Final[float] = 20.0
WEIGHT_CONSTITUTION_HEADROOM: Final[float] = 15.0
WEIGHT_VOLATILITY_VS_STOP: Final[float] = 15.0
WEIGHT_SESSION_LIQUIDITY: Final[float] = 10.0
WEIGHT_BEHAVIOR_FLAGS: Final[float] = 15.0

COMPONENT_WEIGHTS: Final[dict[QualityComponent, float]] = {
    QualityComponent.RISK_REWARD: WEIGHT_RISK_REWARD,
    QualityComponent.STOP_PLACEMENT: WEIGHT_STOP_PLACEMENT,
    QualityComponent.CONSTITUTION_HEADROOM: WEIGHT_CONSTITUTION_HEADROOM,
    QualityComponent.VOLATILITY_VS_STOP: WEIGHT_VOLATILITY_VS_STOP,
    QualityComponent.SESSION_LIQUIDITY: WEIGHT_SESSION_LIQUIDITY,
    QualityComponent.BEHAVIOR_FLAGS: WEIGHT_BEHAVIOR_FLAGS,
}


class StopPlacementQuality(StrEnum):
    """How the stop relates to market structure — supplied by the caller
    (the structure/POI layer decides this; this module only scores it).

    NONE:     arbitrary distance, not anchored to any structural level.
    WEAK:     anchored, but with inadequate buffer beyond the level (likely
              to be wicked out by noise).
    ADEQUATE: anchored beyond a structural level with a sane buffer.
    STRONG:   anchored beyond a strong/confirmed structural level with a
              sane buffer.
    """

    NONE = "none"
    WEAK = "weak"
    ADEQUATE = "adequate"
    STRONG = "strong"


STOP_PLACEMENT_FRACTIONS: Final[dict[StopPlacementQuality, float]] = {
    StopPlacementQuality.NONE: 0.0,
    StopPlacementQuality.WEAK: 0.4,
    StopPlacementQuality.ADEQUATE: 0.75,
    StopPlacementQuality.STRONG: 1.0,
}

# R:R shape: hitting `RR_EXCELLENT_MULTIPLE` times the constitution's minimum
# R:R earns full marks; below the minimum, score falls off proportionally.
RR_EXCELLENT_MULTIPLE: Final[float] = 2.0

# Volatility-vs-stop shape: a "sane" stop sits between 1.0x and 2.5x the
# volatility proxy (e.g. ATR%); score decays linearly outside that band and
# hits zero at the floor/ceiling multiples.
VOL_STOP_IDEAL_MIN_MULTIPLE: Final[float] = 1.0
VOL_STOP_IDEAL_MAX_MULTIPLE: Final[float] = 2.5
VOL_STOP_FLOOR_MULTIPLE: Final[float] = 0.4
VOL_STOP_CEIL_MULTIPLE: Final[float] = 4.0

# Session/liquidity shape: allowed session in a high-liquidity window scores
# full marks; allowed but thinner liquidity scores partial; disallowed
# session scores zero (the constitution would reject the trade outright on
# this ground anyway — the score should agree qualitatively).
SESSION_ALLOWED_FRACTION: Final[float] = 1.0
SESSION_ALLOWED_LOW_LIQUIDITY_FRACTION: Final[float] = 0.6
SESSION_DISALLOWED_FRACTION: Final[float] = 0.0


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _headroom_fraction(used: float, limit: float) -> float:
    """Fraction of a constitution budget still unused, in [0, 1].

    `limit <= 0` means the constitution didn't configure a meaningful cap for
    this dimension (a valid, if unusual, config per `validate_constitution`'s
    `>= 0` bands) — rather than guess intent, that's treated as "not
    constraining" (fraction 1.0) so a permissive config isn't penalized by a
    score component it never opted into.
    """
    if limit <= 0:
        return 1.0
    return _clamp01(1.0 - (used / limit))


@dataclass(frozen=True, slots=True)
class TradeQualityInput:
    """Already-derived inputs only — ratios, percentages, enums, booleans.

    No raw prices/candles/account objects: callers (a future ticket
    assembler) compute these from the constitution, account-state service,
    and structure/volatility layers; this module never reaches for them
    itself.
    """

    # --- R:R ---
    risk_reward_ratio: float
    """Proposed reward measured in multiples of risk (e.g. 2.0 = a 2R target)."""
    min_risk_reward: float
    """The constitution's configured minimum R:R (`min_risk_reward` field)."""

    # --- Stop placement vs structure ---
    stop_placement: StopPlacementQuality

    # --- Constitution headroom ---
    daily_risk_used_percent: float
    daily_loss_limit_percent: float
    weekly_risk_used_percent: float
    weekly_loss_limit_percent: float
    concurrent_positions_open: int
    max_concurrent_positions: int
    correlated_exposure_percent: float
    max_correlated_exposure_percent: float

    # --- Volatility vs stop distance ---
    stop_distance_percent: float
    """Stop distance as a percent of entry price."""
    atr_percent: float
    """A volatility proxy (e.g. ATR) as a percent of price."""

    # --- Session / liquidity ---
    session: str
    allowed_sessions: tuple[str, ...]
    is_high_liquidity_window: bool

    # --- Behavior flags ---
    behavior_flags: tuple[str, ...] = field(default_factory=tuple)
    """Advisory flags from the M9-T11 behavior detectors (subset of
    `KNOWN_BEHAVIOR_DETECTORS`). Presence here is informational input to the
    score regardless of whether the constitution made that detector binding
    — a binding detector rejects the permit outright via the risk engine,
    independent of this score."""


@dataclass(frozen=True, slots=True)
class ComponentScore:
    component: QualityComponent
    weight: float
    fraction: float
    """Raw sub-score in [0, 1] before weighting."""
    points: float
    """`weight * fraction` — this component's contribution to the total."""
    detail: str
    """Human-readable one-liner explaining what drove this component."""


@dataclass(frozen=True, slots=True)
class TradeQualityScore:
    total: float
    """Sum of every component's `points`. Always in [0, 100]."""
    components: tuple[ComponentScore, ...]
    disclaimer: str = SCORE_DISCLAIMER


def _score_risk_reward(inp: TradeQualityInput) -> ComponentScore:
    if inp.min_risk_reward <= 0:
        raise ValueError(f"min_risk_reward must be positive (got {inp.min_risk_reward})")
    if inp.risk_reward_ratio <= 0:
        fraction = 0.0
    else:
        target = inp.min_risk_reward * RR_EXCELLENT_MULTIPLE
        fraction = _clamp01(inp.risk_reward_ratio / target)
    weight = WEIGHT_RISK_REWARD
    return ComponentScore(
        component=QualityComponent.RISK_REWARD,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=(
            f"R:R {inp.risk_reward_ratio:.2f} vs constitution minimum "
            f"{inp.min_risk_reward:.2f} (full marks at {RR_EXCELLENT_MULTIPLE:.1f}x minimum)"
        ),
    )


def _score_stop_placement(inp: TradeQualityInput) -> ComponentScore:
    fraction = STOP_PLACEMENT_FRACTIONS[inp.stop_placement]
    weight = WEIGHT_STOP_PLACEMENT
    return ComponentScore(
        component=QualityComponent.STOP_PLACEMENT,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=f"stop placement rated '{inp.stop_placement.value}' vs structure",
    )


def _score_constitution_headroom(inp: TradeQualityInput) -> ComponentScore:
    daily = _headroom_fraction(inp.daily_risk_used_percent, inp.daily_loss_limit_percent)
    weekly = _headroom_fraction(inp.weekly_risk_used_percent, inp.weekly_loss_limit_percent)
    positions = _headroom_fraction(
        float(inp.concurrent_positions_open), float(inp.max_concurrent_positions)
    )
    correlated = _headroom_fraction(
        inp.correlated_exposure_percent, inp.max_correlated_exposure_percent
    )
    fraction = _clamp01((daily + weekly + positions + correlated) / 4.0)
    weight = WEIGHT_CONSTITUTION_HEADROOM
    return ComponentScore(
        component=QualityComponent.CONSTITUTION_HEADROOM,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=(
            f"headroom — daily {daily:.0%}, weekly {weekly:.0%}, "
            f"positions {positions:.0%}, correlated exposure {correlated:.0%}"
        ),
    )


def _score_volatility_vs_stop(inp: TradeQualityInput) -> ComponentScore:
    weight = WEIGHT_VOLATILITY_VS_STOP
    if inp.atr_percent <= 0 or inp.stop_distance_percent <= 0:
        return ComponentScore(
            component=QualityComponent.VOLATILITY_VS_STOP,
            weight=weight,
            fraction=0.0,
            points=0.0,
            detail="non-positive ATR% or stop distance% — scored conservatively at 0",
        )

    ratio = inp.stop_distance_percent / inp.atr_percent
    if VOL_STOP_IDEAL_MIN_MULTIPLE <= ratio <= VOL_STOP_IDEAL_MAX_MULTIPLE:
        fraction = 1.0
    elif ratio < VOL_STOP_IDEAL_MIN_MULTIPLE:
        span = VOL_STOP_IDEAL_MIN_MULTIPLE - VOL_STOP_FLOOR_MULTIPLE
        fraction = _clamp01((ratio - VOL_STOP_FLOOR_MULTIPLE) / span) if span > 0 else 0.0
    else:
        span = VOL_STOP_CEIL_MULTIPLE - VOL_STOP_IDEAL_MAX_MULTIPLE
        fraction = _clamp01((VOL_STOP_CEIL_MULTIPLE - ratio) / span) if span > 0 else 0.0

    return ComponentScore(
        component=QualityComponent.VOLATILITY_VS_STOP,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=(
            f"stop distance is {ratio:.2f}x ATR% "
            f"(ideal band {VOL_STOP_IDEAL_MIN_MULTIPLE:.1f}x-{VOL_STOP_IDEAL_MAX_MULTIPLE:.1f}x)"
        ),
    )


def _score_session_liquidity(inp: TradeQualityInput) -> ComponentScore:
    weight = WEIGHT_SESSION_LIQUIDITY
    if inp.session in inp.allowed_sessions:
        fraction = (
            SESSION_ALLOWED_FRACTION
            if inp.is_high_liquidity_window
            else SESSION_ALLOWED_LOW_LIQUIDITY_FRACTION
        )
        detail = (
            f"session '{inp.session}' is allowed "
            f"({'high' if inp.is_high_liquidity_window else 'lower'}-liquidity window)"
        )
    else:
        fraction = SESSION_DISALLOWED_FRACTION
        detail = f"session '{inp.session}' is not in the constitution's allowed sessions"
    return ComponentScore(
        component=QualityComponent.SESSION_LIQUIDITY,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=detail,
    )


def _score_behavior_flags(inp: TradeQualityInput) -> ComponentScore:
    flags = set(inp.behavior_flags)
    unknown = flags - KNOWN_BEHAVIOR_DETECTORS
    if unknown:
        raise ValueError(
            f"unknown behavior flag(s): {sorted(unknown)} "
            f"(known: {sorted(KNOWN_BEHAVIOR_DETECTORS)})"
        )
    weight = WEIGHT_BEHAVIOR_FLAGS
    fraction = _clamp01(1.0 - (len(flags) / len(KNOWN_BEHAVIOR_DETECTORS)))
    detail = f"behavior flags present: {sorted(flags)}" if flags else "no behavior flags present"
    return ComponentScore(
        component=QualityComponent.BEHAVIOR_FLAGS,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=detail,
    )


def score_trade_quality(inp: TradeQualityInput) -> TradeQualityScore:
    """Compute the Trade Quality Score. Pure: no I/O, no clock, no randomness.

    Identical `TradeQualityInput` -> identical `TradeQualityScore`, always.
    """
    components = (
        _score_risk_reward(inp),
        _score_stop_placement(inp),
        _score_constitution_headroom(inp),
        _score_volatility_vs_stop(inp),
        _score_session_liquidity(inp),
        _score_behavior_flags(inp),
    )
    total = sum(c.points for c in components)
    assert TQS_MIN <= total <= TQS_MAX, (
        f"Trade Quality Score total {total} out of bounds [{TQS_MIN}, {TQS_MAX}]"
    )
    return TradeQualityScore(total=total, components=components)
