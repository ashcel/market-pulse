"""Catalyst Impact Score — deterministic per-event salience (plan.md "Score").

Rules, not LLM — the same discipline as the Trade Quality Score
(`app/execution/quality_score.py`, docs/trade-quality-score.md): a pure
function of already-stored event facts. No DB, no network, no clock, no
randomness — the caller supplies "hours from now" so identical inputs always
produce identical results. The AI layer may narrate an impact score; it never
generates, adjusts, or re-weights it.

**Not a price forecast.** The score ranks how much attention an event
deserves (magnitude x proximity x source confidence); `direction` is the
per-type prior the classifier plane made explicit, not a prediction. Every
result is stamped with `IMPACT_SCORE_VERSION` so any rule change is visible
in serialized output, mirroring the engine's provenance discipline.

Factors (weights sum to 100):

    magnitude          50   how big the event is for holders of the token
    proximity          30   hours until (calendar) / since (news) the event
    source_confidence  20   trust tier of the ingesting source

Rule table — event types x factors:

    category   kind/tier          magnitude fraction        direction
    ---------  -----------------  ------------------------  ---------
    news       security           severity (critical=1.0)   bearish
    news       delisting          severity (warning=0.6)    bearish
    news       regulatory         severity (warning=0.6)    bearish
    news       unlock             severity (warning=0.6)    bearish
    news       listing            severity (info=0.3)       bullish
    news       upgrade            severity (info=0.3)       bullish
    news       macro              severity (info=0.3)       neutral
    catalyst   unlock (pct known) clamp(pct / 3%, 0, 1)     bearish
    catalyst   unlock (pct None)  0.2 + capped LOW          neutral (scheduling fact)
    catalyst   listing            0.6                       bullish
    catalyst   burn               0.5                       bullish
    catalyst   upgrade            0.4                       bullish
    catalyst   fork               0.4                       neutral
    catalyst   other / unknown    0.25                      neutral
    economic   high               1.0                       neutral
    economic   medium             0.55                      neutral
    economic   low / unknown      0.25                      neutral
    economic   holiday            0.1                       neutral

Historical reaction is deliberately absent: no per-event-type reaction record
exists yet (plan.md "Later" — the event-reaction backtest). It joins as a
fourth factor only once that evidence plane exists; it is never invented.

Degradations (never raises on data gaps, matching the ingest philosophy):
- Unknown-size unlocks are scored as a **scheduling fact** — the project
  convention since the CoinMarketCal free tier: direction neutral, impact
  capped at LOW, `capped=True`.
- A trivial magnitude (<= 0.15) caps the level at LOW so proximity alone can
  never promote a non-event (e.g. an econ "holiday" row tomorrow).
- Unknown kinds/severities/sources fall back to conservative defaults rather
  than raising — an odd row stays visible, not fatal.
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Final

IMPACT_SCORE_VERSION: Final[str] = "1.0.0"

# The label every render site must carry, verbatim or in close paraphrase —
# same honesty rule as SCORE_DISCLAIMER in quality_score.py.
IMPACT_DISCLAIMER: Final[str] = (
    "Deterministic rule-based salience ranking of a known event — not a price forecast."
)

IMPACT_MIN: Final[float] = 0.0
IMPACT_MAX: Final[float] = 100.0


class ImpactLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class Direction(StrEnum):
    BEARISH = "bearish"
    NEUTRAL = "neutral"
    BULLISH = "bullish"


class EventCategory(StrEnum):
    """Which stored plane the event row comes from."""

    NEWS = "news"  # token_event (news-derived, published in the past)
    CATALYST = "catalyst"  # catalyst_event (calendar, occurs in the future)
    ECONOMIC = "economic"  # economic_event (macro calendar)


class ImpactFactor(StrEnum):
    MAGNITUDE = "magnitude"
    PROXIMITY = "proximity"
    SOURCE_CONFIDENCE = "source_confidence"


# Weights — defined once; the module docstring's table must quote these.
WEIGHT_MAGNITUDE: Final[float] = 50.0
WEIGHT_PROXIMITY: Final[float] = 30.0
WEIGHT_SOURCE_CONFIDENCE: Final[float] = 20.0

FACTOR_WEIGHTS: Final[dict[ImpactFactor, float]] = {
    ImpactFactor.MAGNITUDE: WEIGHT_MAGNITUDE,
    ImpactFactor.PROXIMITY: WEIGHT_PROXIMITY,
    ImpactFactor.SOURCE_CONFIDENCE: WEIGHT_SOURCE_CONFIDENCE,
}

# Level thresholds on the 0-100 composite.
HIGH_THRESHOLD: Final[float] = 75.0
MEDIUM_THRESHOLD: Final[float] = 40.0

# Magnitude at or below this can never exceed LOW, whatever the proximity —
# a bank-holiday row tomorrow is still a non-event.
TRIVIAL_MAGNITUDE_MAX: Final[float] = 0.15

# Unlock magnitude: full marks at >= this share of supply (plan.md's ">3%
# supply" working example); linear below.
UNLOCK_PCT_FULL: Final[float] = 0.03
# Size-unknown unlock: fixed conservative magnitude, LOW cap, neutral
# direction — the "scheduling fact, never a supply-pressure signal" rule.
UNKNOWN_UNLOCK_MAGNITUDE: Final[float] = 0.2

# Proximity shape: full marks within a day of the event (either side), linear
# decay out to a week, zero beyond.
PROXIMITY_FULL_HOURS: Final[float] = 24.0
PROXIMITY_ZERO_HOURS: Final[float] = 168.0

# news severity -> magnitude fraction (token_event.severity).
_SEVERITY_MAGNITUDE: Final[dict[str, float]] = {
    "critical": 1.0,
    "warning": 0.6,
    "info": 0.3,
}
_DEFAULT_SEVERITY_MAGNITUDE: Final[float] = 0.3

# news kind -> direction prior (token_event.kind).
_NEWS_DIRECTION: Final[dict[str, Direction]] = {
    "security": Direction.BEARISH,
    "delisting": Direction.BEARISH,
    "regulatory": Direction.BEARISH,
    "unlock": Direction.BEARISH,
    "listing": Direction.BULLISH,
    "upgrade": Direction.BULLISH,
    "macro": Direction.NEUTRAL,
}

# catalyst kind (non-unlock) -> (magnitude fraction, direction).
_CATALYST_RULES: Final[dict[str, tuple[float, Direction]]] = {
    "listing": (0.6, Direction.BULLISH),
    "burn": (0.5, Direction.BULLISH),
    "upgrade": (0.4, Direction.BULLISH),
    "fork": (0.4, Direction.NEUTRAL),
    "other": (0.25, Direction.NEUTRAL),
}
_DEFAULT_CATALYST_RULE: Final[tuple[float, Direction]] = (0.25, Direction.NEUTRAL)

# economic_event.impact (ForexFactory tier) -> magnitude fraction.
_ECON_MAGNITUDE: Final[dict[str, float]] = {
    "high": 1.0,
    "medium": 0.55,
    "low": 0.25,
    "holiday": 0.1,
}
_DEFAULT_ECON_MAGNITUDE: Final[float] = 0.25

# Source trust tiers. Calendar planes (structured data) rank above RSS
# keyword classification; per-ticker Yahoo feeds are the thinnest tier.
_SOURCE_CONFIDENCE: Final[dict[str, float]] = {
    "defillama": 0.9,
    "forexfactory": 0.9,
    "forexfactory-next": 0.85,
    "coinmarketcal": 0.6,
    "coindesk": 0.75,
    "cointelegraph": 0.7,
    "decrypt": 0.65,
    "cnbc-economy": 0.75,
    "cnbc-top": 0.75,
    "marketwatch": 0.75,
}
_YAHOO_SOURCE_PREFIX: Final[str] = "yahoo-"
_YAHOO_SOURCE_CONFIDENCE: Final[float] = 0.6
_DEFAULT_SOURCE_CONFIDENCE: Final[float] = 0.5


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


@dataclass(frozen=True, slots=True)
class EventImpactInput:
    """Already-stored event facts only — no candles, no account state.

    `hours_from_now` is signed (negative = the event already happened, e.g. a
    published news item; positive = upcoming calendar entry). The caller
    computes it from the row's timestamp and its own clock so this module
    stays clockless and deterministic.
    """

    category: EventCategory
    kind: str
    """token_event.kind / catalyst_event.kind; "" for economic rows."""
    source: str
    hours_from_now: float
    severity: str | None = None
    """token_event.severity (info | warning | critical) — news rows only."""
    percent_of_supply: float | None = None
    """Unlock size as a FRACTION of supply (0.03 = 3%) when known; None means
    size unknown -> scheduling-fact treatment."""
    econ_impact: str | None = None
    """economic_event.impact feed tier (high | medium | low | holiday)."""


@dataclass(frozen=True, slots=True)
class ImpactComponent:
    factor: ImpactFactor
    weight: float
    fraction: float
    """Raw sub-score in [0, 1] before weighting."""
    points: float
    """`weight * fraction` — this factor's contribution to the composite."""
    detail: str
    """Human-readable one-liner explaining what drove this factor."""


@dataclass(frozen=True, slots=True)
class ImpactResult:
    impact: ImpactLevel
    direction: Direction
    score: float
    """0-100 composite — the ranking key ("impact x proximity" rails sort on
    this); `impact` is the compact banding of it."""
    components: tuple[ImpactComponent, ...]
    capped: bool
    """True when a degradation rule (size-unknown unlock, trivial magnitude)
    forced the level below what the composite alone would band to."""
    version: str = IMPACT_SCORE_VERSION
    disclaimer: str = IMPACT_DISCLAIMER


def _magnitude(inp: EventImpactInput) -> tuple[ImpactComponent, Direction, bool]:
    """Magnitude fraction + the event type's direction prior.

    Third return: whether this is a size-unknown unlock (scheduling fact),
    which caps the final level at LOW.
    """
    scheduling_fact = False
    if inp.category is EventCategory.NEWS:
        severity = (inp.severity or "").lower()
        fraction = _SEVERITY_MAGNITUDE.get(severity, _DEFAULT_SEVERITY_MAGNITUDE)
        direction = _NEWS_DIRECTION.get(inp.kind.lower(), Direction.NEUTRAL)
        detail = f"news '{inp.kind}' at severity '{severity or 'unknown'}'"
    elif inp.category is EventCategory.CATALYST and inp.kind.lower() == "unlock":
        if inp.percent_of_supply is not None and inp.percent_of_supply >= 0:
            fraction = _clamp01(inp.percent_of_supply / UNLOCK_PCT_FULL)
            direction = Direction.BEARISH
            detail = (
                f"unlock of {inp.percent_of_supply * 100:.2f}% of supply "
                f"(full marks at {UNLOCK_PCT_FULL * 100:.0f}%+)"
            )
        else:
            fraction = UNKNOWN_UNLOCK_MAGNITUDE
            direction = Direction.NEUTRAL
            scheduling_fact = True
            detail = "unlock of unknown size — scheduling fact, capped at low impact"
    elif inp.category is EventCategory.CATALYST:
        fraction, direction = _CATALYST_RULES.get(inp.kind.lower(), _DEFAULT_CATALYST_RULE)
        detail = f"calendar catalyst '{inp.kind or 'unknown'}'"
    else:
        tier = (inp.econ_impact or "").lower()
        fraction = _ECON_MAGNITUDE.get(tier, _DEFAULT_ECON_MAGNITUDE)
        direction = Direction.NEUTRAL
        detail = f"economic calendar tier '{tier or 'unknown'}'"

    weight = WEIGHT_MAGNITUDE
    component = ImpactComponent(
        factor=ImpactFactor.MAGNITUDE,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=detail,
    )
    return component, direction, scheduling_fact


def _proximity(inp: EventImpactInput) -> ImpactComponent:
    hours = abs(inp.hours_from_now)
    if hours <= PROXIMITY_FULL_HOURS:
        fraction = 1.0
    elif hours >= PROXIMITY_ZERO_HOURS:
        fraction = 0.0
    else:
        span = PROXIMITY_ZERO_HOURS - PROXIMITY_FULL_HOURS
        fraction = _clamp01((PROXIMITY_ZERO_HOURS - hours) / span)
    tense = "until" if inp.hours_from_now >= 0 else "since"
    weight = WEIGHT_PROXIMITY
    return ImpactComponent(
        factor=ImpactFactor.PROXIMITY,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=(
            f"{hours:.0f}h {tense} the event "
            f"(full inside {PROXIMITY_FULL_HOURS:.0f}h, zero beyond {PROXIMITY_ZERO_HOURS:.0f}h)"
        ),
    )


def _source_confidence(inp: EventImpactInput) -> ImpactComponent:
    source = inp.source.lower()
    if source in _SOURCE_CONFIDENCE:
        fraction = _SOURCE_CONFIDENCE[source]
    elif source.startswith(_YAHOO_SOURCE_PREFIX):
        fraction = _YAHOO_SOURCE_CONFIDENCE
    else:
        fraction = _DEFAULT_SOURCE_CONFIDENCE
    weight = WEIGHT_SOURCE_CONFIDENCE
    return ImpactComponent(
        factor=ImpactFactor.SOURCE_CONFIDENCE,
        weight=weight,
        fraction=fraction,
        points=weight * fraction,
        detail=f"source '{inp.source or 'unknown'}' trust tier {fraction:.2f}",
    )


def _band(score: float) -> ImpactLevel:
    if score >= HIGH_THRESHOLD:
        return ImpactLevel.HIGH
    if score >= MEDIUM_THRESHOLD:
        return ImpactLevel.MEDIUM
    return ImpactLevel.LOW


def score_event(inp: EventImpactInput) -> ImpactResult:
    """Compute the Catalyst Impact Score. Pure: no I/O, no clock, no randomness.

    Identical `EventImpactInput` -> identical `ImpactResult`, always.
    """
    magnitude, direction, scheduling_fact = _magnitude(inp)
    components = (magnitude, _proximity(inp), _source_confidence(inp))
    score = sum(c.points for c in components)
    assert IMPACT_MIN <= score <= IMPACT_MAX, (
        f"impact score {score} out of bounds [{IMPACT_MIN}, {IMPACT_MAX}]"
    )

    banded = _band(score)
    level = banded
    if scheduling_fact or magnitude.fraction <= TRIVIAL_MAGNITUDE_MAX:
        level = ImpactLevel.LOW
    return ImpactResult(
        impact=level,
        direction=direction,
        score=score,
        components=components,
        capped=level is not banded,
    )
