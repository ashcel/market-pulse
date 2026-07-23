"""Tests for the pure Catalyst Impact Score module (plan.md "Score" step).

No DB, no network, no app import — safe to run in isolation:

    cd backend && .venv/bin/python -m pytest tests/test_events_impact.py -q

Covers:
  1. determinism: identical input -> identical result, run twice
  2. version stamping: every result carries IMPACT_SCORE_VERSION
  3. the per-type rule table: direction + magnitude for every event type that
     actually exists in the data (news kinds, catalyst kinds, econ tiers)
  4. boundary proximities: full inside 24h, linear to 168h, zero beyond,
     symmetric for past (news) and future (calendar) events
  5. unknown-magnitude degradation: size-unknown unlocks are scheduling
     facts — neutral, capped LOW, never a supply-pressure signal
  6. bounds + composition: score == sum of component points, always in [0, 100]
"""

import pytest

from app.events.impact import (
    FACTOR_WEIGHTS,
    IMPACT_DISCLAIMER,
    IMPACT_SCORE_VERSION,
    TRIVIAL_MAGNITUDE_MAX,
    UNLOCK_PCT_FULL,
    Direction,
    EventCategory,
    EventImpactInput,
    ImpactFactor,
    ImpactLevel,
    score_event,
)


def _news(**overrides) -> EventImpactInput:
    defaults = dict(
        category=EventCategory.NEWS,
        kind="security",
        source="coindesk",
        hours_from_now=-2.0,
        severity="critical",
    )
    defaults.update(overrides)
    return EventImpactInput(**defaults)


def _unlock(**overrides) -> EventImpactInput:
    defaults = dict(
        category=EventCategory.CATALYST,
        kind="unlock",
        source="defillama",
        hours_from_now=32.0,
        percent_of_supply=0.041,
    )
    defaults.update(overrides)
    return EventImpactInput(**defaults)


def _econ(**overrides) -> EventImpactInput:
    defaults = dict(
        category=EventCategory.ECONOMIC,
        kind="",
        source="forexfactory",
        hours_from_now=6.0,
        econ_impact="high",
    )
    defaults.update(overrides)
    return EventImpactInput(**defaults)


def _fraction(result, factor: ImpactFactor) -> float:
    return next(c.fraction for c in result.components if c.factor is factor)


# ---------------------------------------------------------------------------
# 1. Determinism
# ---------------------------------------------------------------------------


def test_identical_input_identical_result() -> None:
    inp = _unlock()
    assert score_event(inp) == score_event(inp)


def test_repeated_scoring_is_stable() -> None:
    inp = _news(kind="regulatory", severity="warning", hours_from_now=-70.0)
    first = score_event(inp)
    for _ in range(20):
        assert score_event(inp) == first


# ---------------------------------------------------------------------------
# 2. Version stamping
# ---------------------------------------------------------------------------


def test_every_result_is_version_stamped() -> None:
    for inp in (_news(), _unlock(), _econ()):
        result = score_event(inp)
        assert result.version == IMPACT_SCORE_VERSION
        assert result.disclaimer == IMPACT_DISCLAIMER


def test_version_is_semver_shaped() -> None:
    major, minor, patch = IMPACT_SCORE_VERSION.split(".")
    assert all(part.isdigit() for part in (major, minor, patch))


# ---------------------------------------------------------------------------
# 3. Rule table — news kinds (token_event)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "direction"),
    [
        ("security", Direction.BEARISH),
        ("delisting", Direction.BEARISH),
        ("regulatory", Direction.BEARISH),
        ("unlock", Direction.BEARISH),
        ("listing", Direction.BULLISH),
        ("upgrade", Direction.BULLISH),
        ("macro", Direction.NEUTRAL),
    ],
)
def test_news_kind_directions(kind: str, direction: Direction) -> None:
    assert score_event(_news(kind=kind, severity="info")).direction is direction


def test_unknown_news_kind_defaults_neutral() -> None:
    result = score_event(_news(kind="something-new", severity="info"))
    assert result.direction is Direction.NEUTRAL


@pytest.mark.parametrize(
    ("severity", "fraction"),
    [("critical", 1.0), ("warning", 0.6), ("info", 0.3), ("unheard-of", 0.3), (None, 0.3)],
)
def test_news_severity_magnitude(severity: str | None, fraction: float) -> None:
    result = score_event(_news(severity=severity))
    assert _fraction(result, ImpactFactor.MAGNITUDE) == pytest.approx(fraction)


def test_critical_security_news_now_is_high_impact() -> None:
    result = score_event(_news(kind="security", severity="critical", hours_from_now=-1.0))
    assert result.impact is ImpactLevel.HIGH
    assert result.direction is Direction.BEARISH


# ---------------------------------------------------------------------------
# 3. Rule table — catalyst kinds (catalyst_event)
# ---------------------------------------------------------------------------


def test_known_size_unlock_near_term_is_high_bearish() -> None:
    result = score_event(_unlock(percent_of_supply=0.041, hours_from_now=32.0))
    assert result.impact is ImpactLevel.HIGH
    assert result.direction is Direction.BEARISH
    assert _fraction(result, ImpactFactor.MAGNITUDE) == pytest.approx(1.0)
    assert not result.capped


def test_unlock_magnitude_scales_linearly_below_full_pct() -> None:
    result = score_event(_unlock(percent_of_supply=UNLOCK_PCT_FULL / 2))
    assert _fraction(result, ImpactFactor.MAGNITUDE) == pytest.approx(0.5)


def test_large_unlock_far_out_is_medium_not_high() -> None:
    # Proximity zero (40 days out) keeps even a 4% unlock below the HIGH band.
    result = score_event(_unlock(percent_of_supply=0.04, hours_from_now=40 * 24.0))
    assert result.impact is ImpactLevel.MEDIUM
    assert result.direction is Direction.BEARISH


def test_dust_unlock_never_exceeds_low_even_imminent() -> None:
    # 0.2% of supply -> trivial magnitude; proximity alone must not promote it.
    result = score_event(_unlock(percent_of_supply=0.002, hours_from_now=2.0))
    assert _fraction(result, ImpactFactor.MAGNITUDE) <= TRIVIAL_MAGNITUDE_MAX
    assert result.impact is ImpactLevel.LOW


@pytest.mark.parametrize(
    ("kind", "direction"),
    [
        ("listing", Direction.BULLISH),
        ("burn", Direction.BULLISH),
        ("upgrade", Direction.BULLISH),
        ("fork", Direction.NEUTRAL),
        ("other", Direction.NEUTRAL),
        ("never-seen", Direction.NEUTRAL),
    ],
)
def test_catalyst_kind_directions(kind: str, direction: Direction) -> None:
    result = score_event(_unlock(kind=kind, percent_of_supply=None))
    assert result.direction is direction


# ---------------------------------------------------------------------------
# 3. Rule table — econ tiers (economic_event)
# ---------------------------------------------------------------------------


def test_high_econ_print_near_term_is_high_neutral() -> None:
    result = score_event(_econ(econ_impact="high", hours_from_now=6.0))
    assert result.impact is ImpactLevel.HIGH
    assert result.direction is Direction.NEUTRAL


def test_holiday_is_low_even_tomorrow() -> None:
    result = score_event(_econ(econ_impact="holiday", hours_from_now=12.0))
    assert result.impact is ImpactLevel.LOW
    assert result.capped  # proximity would band it higher; trivial-magnitude cap holds


@pytest.mark.parametrize(
    ("tier", "fraction"),
    [("high", 1.0), ("medium", 0.55), ("low", 0.25), ("holiday", 0.1), ("odd", 0.25), (None, 0.25)],
)
def test_econ_tier_magnitude(tier: str | None, fraction: float) -> None:
    result = score_event(_econ(econ_impact=tier))
    assert _fraction(result, ImpactFactor.MAGNITUDE) == pytest.approx(fraction)


# ---------------------------------------------------------------------------
# 4. Boundary proximities
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("hours", "fraction"),
    [
        (0.0, 1.0),
        (24.0, 1.0),  # boundary: still full
        (96.0, 0.5),  # midpoint of the decay window
        (168.0, 0.0),  # boundary: exactly zero
        (169.0, 0.0),  # beyond the window
        (-24.0, 1.0),  # past events mirror future ones
        (-96.0, 0.5),
        (-168.0, 0.0),
    ],
)
def test_proximity_boundaries(hours: float, fraction: float) -> None:
    result = score_event(_unlock(hours_from_now=hours))
    assert _fraction(result, ImpactFactor.PROXIMITY) == pytest.approx(fraction)


# ---------------------------------------------------------------------------
# 5. Unknown-magnitude degradation (scheduling-fact convention)
# ---------------------------------------------------------------------------


def test_size_unknown_unlock_is_scheduling_fact() -> None:
    result = score_event(_unlock(percent_of_supply=None, hours_from_now=2.0))
    assert result.impact is ImpactLevel.LOW
    assert result.direction is Direction.NEUTRAL  # never a supply-pressure signal
    assert result.capped
    magnitude = next(c for c in result.components if c.factor is ImpactFactor.MAGNITUDE)
    assert "scheduling fact" in magnitude.detail


def test_size_unknown_unlock_still_scores_all_factors() -> None:
    result = score_event(_unlock(percent_of_supply=None))
    assert {c.factor for c in result.components} == set(ImpactFactor)
    assert result.score > 0.0  # degraded, not zeroed


def test_unknown_source_degrades_to_default_confidence() -> None:
    known = score_event(_unlock(source="defillama"))
    unknown = score_event(_unlock(source="brand-new-feed"))
    assert _fraction(unknown, ImpactFactor.SOURCE_CONFIDENCE) == pytest.approx(0.5)
    assert unknown.score < known.score


def test_yahoo_prefixed_sources_share_a_tier() -> None:
    nvda = score_event(_news(source="yahoo-NVDA"))
    tsla = score_event(_news(source="yahoo-TSLA"))
    assert _fraction(nvda, ImpactFactor.SOURCE_CONFIDENCE) == pytest.approx(
        _fraction(tsla, ImpactFactor.SOURCE_CONFIDENCE)
    )


# ---------------------------------------------------------------------------
# 6. Bounds + composition
# ---------------------------------------------------------------------------


def test_weights_sum_to_100() -> None:
    assert sum(FACTOR_WEIGHTS.values()) == pytest.approx(100.0)


@pytest.mark.parametrize(
    "inp",
    [
        _news(),
        _news(kind="macro", severity="info", hours_from_now=-500.0),
        _unlock(),
        _unlock(percent_of_supply=None),
        _unlock(percent_of_supply=0.5, hours_from_now=0.0),
        _econ(),
        _econ(econ_impact="holiday", hours_from_now=1.0),
    ],
)
def test_score_composes_and_stays_in_bounds(inp: EventImpactInput) -> None:
    result = score_event(inp)
    assert 0.0 <= result.score <= 100.0
    assert result.score == pytest.approx(sum(c.points for c in result.components))
    for component in result.components:
        assert 0.0 <= component.fraction <= 1.0
        assert 0.0 <= component.points <= component.weight
