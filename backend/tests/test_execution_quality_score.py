"""Tests for the pure Trade Quality Score module (M9-T4).

No DB, no network, no app import — safe to run in isolation:

    cd backend && .venv/bin/python -m pytest tests/test_execution_quality_score.py -q

Covers the DoD's assertions:
  1. determinism: identical input -> identical score, run twice
  2. component sub-scores compose (sum) to the documented total
  3. bounds: total always in [0, 100], each component's points in [0, weight]
  4. weights are documented and sum to 100
  5. edge cases: unknown behavior flag / non-positive config raise; market-
     data edge cases (non-positive ATR) degrade the component, don't raise
"""

import copy
import dataclasses

import pytest

from app.execution.quality_score import (
    COMPONENT_WEIGHTS,
    SCORE_DISCLAIMER,
    TQS_MAX,
    TQS_MIN,
    QualityComponent,
    StopPlacementQuality,
    TradeQualityInput,
    TradeQualityScore,
    score_trade_quality,
)


def _base_input(**overrides) -> TradeQualityInput:
    defaults = dict(
        risk_reward_ratio=3.0,
        min_risk_reward=1.5,
        stop_placement=StopPlacementQuality.STRONG,
        daily_risk_used_percent=1.0,
        daily_loss_limit_percent=5.0,
        weekly_risk_used_percent=2.0,
        weekly_loss_limit_percent=10.0,
        concurrent_positions_open=1,
        max_concurrent_positions=5,
        correlated_exposure_percent=10.0,
        max_correlated_exposure_percent=50.0,
        stop_distance_percent=2.0,
        atr_percent=1.2,
        session="london",
        allowed_sessions=("london", "new_york"),
        is_high_liquidity_window=True,
        behavior_flags=(),
    )
    defaults.update(overrides)
    return TradeQualityInput(**defaults)


# ---------------------------------------------------------------------------
# 1. Determinism
# ---------------------------------------------------------------------------


def test_determinism_identical_input_identical_score():
    inp = _base_input()
    first = score_trade_quality(inp)
    second = score_trade_quality(copy.deepcopy(inp))
    assert first == second
    assert first.total == second.total
    assert first.components == second.components


def test_determinism_across_many_repeated_calls():
    inp = _base_input(risk_reward_ratio=1.8, stop_placement=StopPlacementQuality.WEAK)
    scores = [score_trade_quality(inp) for _ in range(20)]
    assert len(set(s.total for s in scores)) == 1
    assert len(set(scores)) == 1


# ---------------------------------------------------------------------------
# 2. Composition: components sum exactly to total
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        {},
        {"risk_reward_ratio": 0.5, "stop_placement": StopPlacementQuality.NONE},
        {"behavior_flags": ("revenge", "tilt")},
        {"session": "asia", "allowed_sessions": ("london",)},
        {"daily_risk_used_percent": 5.0, "daily_loss_limit_percent": 5.0},
        {"atr_percent": 0.0},
        {"daily_loss_limit_percent": 0.0, "weekly_loss_limit_percent": 0.0},
    ],
)
def test_components_sum_to_total(overrides):
    inp = _base_input(**overrides)
    score = score_trade_quality(inp)
    assert score.total == sum(c.points for c in score.components)
    # every documented component is present exactly once
    assert {c.component for c in score.components} == set(QualityComponent)


# ---------------------------------------------------------------------------
# 3. Bounds
# ---------------------------------------------------------------------------


def test_bounds_best_case_near_max():
    inp = _base_input(
        risk_reward_ratio=10.0,
        stop_placement=StopPlacementQuality.STRONG,
        daily_risk_used_percent=0.0,
        weekly_risk_used_percent=0.0,
        concurrent_positions_open=0,
        correlated_exposure_percent=0.0,
        stop_distance_percent=1.5,
        atr_percent=1.0,
        session="london",
        allowed_sessions=("london",),
        is_high_liquidity_window=True,
        behavior_flags=(),
    )
    score = score_trade_quality(inp)
    assert score.total == pytest.approx(TQS_MAX)
    for c in score.components:
        assert c.fraction == pytest.approx(1.0)


def test_bounds_worst_case_near_min():
    inp = _base_input(
        risk_reward_ratio=0.0,
        stop_placement=StopPlacementQuality.NONE,
        daily_risk_used_percent=5.0,
        daily_loss_limit_percent=5.0,
        weekly_risk_used_percent=10.0,
        weekly_loss_limit_percent=10.0,
        concurrent_positions_open=5,
        max_concurrent_positions=5,
        correlated_exposure_percent=50.0,
        max_correlated_exposure_percent=50.0,
        stop_distance_percent=20.0,
        atr_percent=1.0,
        session="asia",
        allowed_sessions=("london", "new_york"),
        is_high_liquidity_window=False,
        behavior_flags=("revenge", "overtrading", "tilt"),
    )
    score = score_trade_quality(inp)
    assert score.total == pytest.approx(TQS_MIN)


@pytest.mark.parametrize(
    "overrides",
    [
        {"risk_reward_ratio": 100.0},
        {"stop_distance_percent": 0.0001, "atr_percent": 50.0},
        {"correlated_exposure_percent": 1000.0, "max_correlated_exposure_percent": 1.0},
        {"concurrent_positions_open": 999, "max_concurrent_positions": 1},
    ],
)
def test_bounds_extreme_inputs_stay_in_range(overrides):
    inp = _base_input(**overrides)
    score = score_trade_quality(inp)
    assert TQS_MIN <= score.total <= TQS_MAX
    for c in score.components:
        assert 0.0 <= c.fraction <= 1.0
        assert 0.0 <= c.points <= c.weight


# ---------------------------------------------------------------------------
# 4. Weights documented + sum to 100
# ---------------------------------------------------------------------------


def test_weights_sum_to_100():
    assert sum(COMPONENT_WEIGHTS.values()) == pytest.approx(100.0)


def test_every_quality_component_has_a_weight():
    assert set(COMPONENT_WEIGHTS.keys()) == set(QualityComponent)


def test_score_reports_weight_matching_component_weights():
    inp = _base_input()
    score = score_trade_quality(inp)
    for c in score.components:
        assert c.weight == COMPONENT_WEIGHTS[c.component]


def test_disclaimer_present_and_not_a_probability_claim():
    inp = _base_input()
    score = score_trade_quality(inp)
    assert score.disclaimer == SCORE_DISCLAIMER
    disclaimer_lower = SCORE_DISCLAIMER.lower()
    assert "not" in disclaimer_lower and "win-probability" in disclaimer_lower
    assert "rule-compliance" in disclaimer_lower and "setup quality" in disclaimer_lower


# ---------------------------------------------------------------------------
# 5. Edge cases
# ---------------------------------------------------------------------------


def test_unknown_behavior_flag_raises():
    inp = _base_input(behavior_flags=("revenge", "fomo"))
    with pytest.raises(ValueError, match="unknown behavior flag"):
        score_trade_quality(inp)


def test_non_positive_min_risk_reward_raises():
    inp = _base_input(min_risk_reward=0.0)
    with pytest.raises(ValueError, match="min_risk_reward"):
        score_trade_quality(inp)


def test_non_positive_atr_degrades_component_without_raising():
    inp = _base_input(atr_percent=0.0)
    score = score_trade_quality(inp)
    vol_component = next(
        c for c in score.components if c.component is QualityComponent.VOLATILITY_VS_STOP
    )
    assert vol_component.fraction == 0.0
    assert vol_component.points == 0.0


def test_zero_configured_limit_treated_as_no_constraint_not_divide_by_zero():
    inp = _base_input(daily_loss_limit_percent=0.0, daily_risk_used_percent=0.0)
    score = score_trade_quality(inp)  # must not raise ZeroDivisionError
    headroom = next(
        c for c in score.components if c.component is QualityComponent.CONSTITUTION_HEADROOM
    )
    assert 0.0 <= headroom.fraction <= 1.0


def test_session_not_allowed_scores_zero_for_that_component():
    inp = _base_input(session="asia", allowed_sessions=("london", "new_york"))
    score = score_trade_quality(inp)
    session_component = next(
        c for c in score.components if c.component is QualityComponent.SESSION_LIQUIDITY
    )
    assert session_component.fraction == 0.0


def test_behavior_flags_each_reduce_score_monotonically():
    none_score = score_trade_quality(_base_input(behavior_flags=())).components
    one_score = score_trade_quality(_base_input(behavior_flags=("revenge",))).components
    two_score = score_trade_quality(_base_input(behavior_flags=("revenge", "tilt"))).components

    def points_for(components, component):
        return next(c.points for c in components if c.component is component)

    p0 = points_for(none_score, QualityComponent.BEHAVIOR_FLAGS)
    p1 = points_for(one_score, QualityComponent.BEHAVIOR_FLAGS)
    p2 = points_for(two_score, QualityComponent.BEHAVIOR_FLAGS)
    assert p0 > p1 > p2 >= 0.0


def test_result_is_frozen_dataclass():
    inp = _base_input()
    score = score_trade_quality(inp)
    assert dataclasses.is_dataclass(score)
    with pytest.raises(dataclasses.FrozenInstanceError):
        score.total = 0.0  # type: ignore[misc]


def test_returns_trade_quality_score_type():
    score = score_trade_quality(_base_input())
    assert isinstance(score, TradeQualityScore)
