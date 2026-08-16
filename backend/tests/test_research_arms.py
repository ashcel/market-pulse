"""The arms registry and the weekly report that judges it.

Most of these tests are about *refusing* to produce a result: the failure mode
this whole layer exists to prevent is a confident verdict on a sample that
cannot carry one.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from smc.arms import (
    ARMS,
    DETECT_ARMS,
    EXIT_ARMS,
    MAX_ARMS_PER_AXIS,
    PLAN_ARMS,
    WIDE_STOP_MIN_RISK_PCT,
    Arm,
    Gate,
    arm_flag_values,
    arm_named,
    detector_flags,
    settlement_variants,
    widened_plan,
)
from smc.forward_test import DEFAULT_FORWARD_TEST_CONFIG as CFG
from smc.forward_test import SetupSnapshot, cost_in_r

from app.research.arms_report import (
    ArmResult,
    Report,
    Row,
    _judge,
    cost_scenario,
    costed_rows,
    holm,
    legacy_taker_scenario,
    paired,
    render_markdown,
    render_telegram,
    unpaired,
)
from app.research.recorder import STRATEGY_VERSION

T0 = 1_700_000_000.0


def snapshot(**overrides: object) -> SetupSnapshot:
    base = dict(
        symbol="BTCUSDT",
        market="perp",
        mode="SCALP",
        direction="bullish",
        detected_at=T0,
        state="PULLBACK_COMPLETION",
        tier="A",
        combo="structure+activity",
        families=("structure",),
        score=0.7,
        entry_low=99.6,
        entry_high=100.0,
        reference_entry=100.0,
        initial_invalidation=99.0,
        target=105.0,
        target_kind="liquidity",
        potential_rr=5.0,
        htf_bias="bullish",
        htf_agreement=0.8,
        alignment="ALIGNED",
        alignment_level="1H",
        structure_trend="up",
        headline_event="VOLUME_SPIKE",
        event_age_seconds=30.0,
        rvol=3.0,
        change_1m_pct=0.4,
        change_3m_pct=0.9,
        change_5m_pct=1.2,
        change_15m_pct=2.0,
        retrace_frac=0.5,
        pullback_volume_ratio=0.6,
        completion_evidence=("micro_choch",),
        micro_choch=True,
        liquidity_target=True,
        engine_version="2.0.0",
        momentum_version="1",
        events_version="1",
        context_version="1",
        forward_test_version="1",
        config_hash="abc",
        git_sha="deadbeef",
    )
    base.update(overrides)
    return SetupSnapshot(**base)  # type: ignore[arg-type]


# ── the registry ─────────────────────────────────────────────────────────────


def test_the_arm_budget_is_enforced_not_documented() -> None:
    """Three simultaneous answers per axis is the power budget. A registry that
    quietly grew to four would make every gate in it unreachable."""
    for axis in ("exit", "plan", "detect"):
        active = [a for a in ARMS if a.axis == axis and a.active]
        assert len(active) + 1 <= MAX_ARMS_PER_AXIS


def test_every_arm_states_a_falsifiable_hypothesis_and_a_gate() -> None:
    for arm in ARMS:
        assert arm.hypothesis.strip(), f"{arm.name} has no hypothesis"
        assert arm.registered, f"{arm.name} has no registration date"
        assert arm.gate.min_settled > 0
        # Gross-only gates. A net gate would promote a wide stop for the
        # arithmetic of paying less fee per R.
        assert arm.gate.min_gross_edge_r > 0


def test_detector_arms_never_reach_settlement() -> None:
    """A detector arm changes which setups exist. Settling one would mean
    running a second detector, which is not what the flag records."""
    settled = {v.name for v in settlement_variants(CFG)}
    assert settled.isdisjoint({a.name for a in DETECT_ARMS})
    assert settled == {a.name for a in EXIT_ARMS + PLAN_ARMS if a.active}


def test_registering_a_fourth_arm_on_an_axis_is_refused() -> None:
    from smc import arms as arms_module

    crowded = (
        *arms_module.ARMS,
        Arm("extra", "exit", "one too many", "2026-08-14", Gate(min_settled=1)),
    )
    original = arms_module.ARMS
    try:
        arms_module.ARMS = crowded
        with pytest.raises(ValueError, match="MAX_ARMS_PER_AXIS"):
            arms_module._validate()
    finally:
        arms_module.ARMS = original


# ── the wide_stop plan arm ───────────────────────────────────────────────────


def test_wide_stop_holds_the_floor_and_leaves_the_target_alone() -> None:
    tight = snapshot(initial_invalidation=99.5)  # 0.5% stop
    widened = widened_plan(tight, CFG)
    assert widened is not None
    risk_pct = abs(widened.reference_entry - widened.initial_invalidation) / 100.0 * 100
    assert risk_pct == pytest.approx(WIDE_STOP_MIN_RISK_PCT, rel=1e-6)
    # The target is the control's, untouched: the arm asks whether surviving
    # the noise beats the better nominal RR, not whether a nearer target does.
    assert widened.target == tight.target
    assert widened.potential_rr < tight.potential_rr


def test_wide_stop_is_absent_when_the_control_already_clears_the_floor() -> None:
    """Recording the control's own geometry under the arm's name would fill the
    comparison with identical rows and dilute it toward zero."""
    already_wide = snapshot(initial_invalidation=97.0)  # 3% stop
    assert widened_plan(already_wide, CFG) is None


def test_wide_stop_actually_cuts_the_cost_it_was_registered_to_cut() -> None:
    tight = snapshot(initial_invalidation=99.5)
    widened = widened_plan(tight, CFG)
    assert widened is not None
    before = cost_in_r(tight, 100.0, CFG)
    after = cost_in_r(widened, 100.0, CFG)
    assert after < before / 2


def test_wide_stop_keeps_the_direction_of_the_stop() -> None:
    bearish = snapshot(direction="bearish", initial_invalidation=100.5, target=95.0)
    widened = widened_plan(bearish, CFG)
    assert widened is not None
    assert widened.initial_invalidation > widened.reference_entry


# ── detector flags ───────────────────────────────────────────────────────────


def test_detector_flags_are_frozen_reads_of_the_snapshot() -> None:
    taken = snapshot(combo="displacement+participation", htf_bias="bullish")
    flags = detector_flags(taken)
    assert flags["displacement_only"] is True
    assert flags["htf_aligned"] is True

    rejected = snapshot(combo="structure+activity", htf_bias="bearish")
    flags = detector_flags(rejected)
    assert flags["displacement_only"] is False
    assert flags["htf_aligned"] is False


def test_arm_flags_carry_the_registry_version() -> None:
    """Two registries must never pool. The version travels on the row."""
    values = arm_flag_values(snapshot())
    assert values["version"]
    assert set(values["detect"]) == {a.name for a in DETECT_ARMS if a.active}


# ── statistics ───────────────────────────────────────────────────────────────


def test_pairing_removes_the_between_setup_variance() -> None:
    """The reason a 0.07R difference is affordable at all."""
    control = [3.0, -1.0, 2.0, -1.0, 4.0, -1.0]
    arm = [x + 0.1 for x in control]
    result = paired(control, arm)
    assert result is not None
    assert result.edge == pytest.approx(0.1)
    # Identical disagreement on every setup → no residual variance at all.
    assert result.se == pytest.approx(0.0)


def test_holm_is_monotone_and_corrects_the_family() -> None:
    adjusted = holm({"a": 0.01, "b": 0.02, "c": 0.60})
    assert adjusted["a"] == pytest.approx(0.03)
    assert adjusted["b"] == pytest.approx(0.04)
    assert adjusted["c"] == pytest.approx(0.60)
    # Never decreasing as raw p grows.
    assert adjusted["a"] <= adjusted["b"] <= adjusted["c"]


def test_unpaired_needs_both_sides() -> None:
    assert unpaired([1.0], [2.0, 3.0]) is None


def test_n_for_significance_is_silent_about_adverse_effects() -> None:
    losing = paired([1.0, 2.0, 3.0, 1.0], [0.5, 1.4, 2.6, 0.4])
    assert losing is not None
    assert losing.edge < 0
    assert losing.n_for_significance() is None


# ── verdicts ─────────────────────────────────────────────────────────────────


def _result(arm: Arm, edge: float, n: int, p_holm: float) -> ArmResult:
    control = [0.0] * n
    values = [edge] * n
    # A hair of variance so the comparison is well-formed.
    values[0] += 1e-6
    result = ArmResult(arm=arm, gross=paired(control, values), net=None, week_n=0)
    result.p_holm = p_holm
    return result


def test_an_arm_below_its_floor_gets_no_verdict_at_all() -> None:
    """`structural_swing` once showed t=+2.82 at n=6 on a gross difference of
    exactly zero. A floor is the only thing that stops that becoming a claim."""
    arm = arm_named("structural_swing")
    assert arm is not None
    result = _result(arm, 0.5, 6, 0.001)
    _judge(result)
    assert result.verdict == "INSUFFICIENT"
    assert "short" in result.note
    # No p-value, no ranking, no edge quoted as a finding.
    assert "0.001" not in result.note


def test_a_significant_arm_over_its_floor_passes_but_promotes_nothing() -> None:
    arm = arm_named("no_trail")
    assert arm is not None
    result = _result(arm, 0.20, 500, 0.01)
    _judge(result)
    assert result.verdict == "PASS"
    assert "human decision" in result.note


def test_a_significant_but_tiny_edge_fails_the_minimum() -> None:
    arm = arm_named("no_trail")
    assert arm is not None
    result = _result(arm, 0.01, 500, 0.001)
    _judge(result)
    assert result.verdict == "FAIL"


def test_an_arm_significantly_beaten_by_the_control_is_retired() -> None:
    arm = arm_named("wide_trail")
    assert arm is not None
    result = _result(arm, -0.30, 500, 0.001)
    _judge(result)
    assert result.verdict == "RETIRE"


# ── cost scenarios ───────────────────────────────────────────────────────────


def _row(**overrides: object) -> Row:
    base = dict(
        id="1",
        mode="SCALP",
        status="INVALIDATED",
        settled_at=datetime.now(UTC),
        entry_price=100.0,
        initial_invalidation=99.0,
        gross_r=-1.0,
        realized_r=-1.2,
        cost_r=0.2,
        exit_reason="invalidation",
        strategy_version=STRATEGY_VERSION,
        variants={},
        arm_flags={},
    )
    base.update(overrides)
    return Row(**base)  # type: ignore[arg-type]


def test_scenarios_share_one_denominator() -> None:
    """A filled row settled before costs were recorded is a missing
    measurement, not a free trade. Letting it into one scenario and not the
    other moved the live number by 0.05R once already."""
    rows = [_row(), _row(id="2", cost_r=0.0), _row(id="3", entry_price=None)]
    eligible = costed_rows(rows)
    assert [r.id for r in eligible] == ["1"]


def test_a_cheaper_round_trip_is_re_derived_not_re_run() -> None:
    rows = costed_rows([_row(gross_r=0.5)])
    cheap = cost_scenario(rows, "maker", 0.06)
    assert cheap is not None
    # 0.06% of a 100.0 entry over a 1.0 stop = 0.06R.
    assert cheap.mean_cost == pytest.approx(0.06)
    assert cheap.mean_net == pytest.approx(0.44)


def test_a_row_from_another_generation_is_kept_out_of_the_cost_scenarios() -> None:
    """The live column reads `realized_r` straight off the row, and generation
    6 changed how that number is computed. Pooling the two would report a mean
    net R no single cost model ever produced."""
    rows = [_row(), _row(id="2", strategy_version="discover-forward-test/1.2.0")]
    assert [r.id for r in costed_rows(rows)] == ["1"]


def test_the_legacy_scenario_prices_both_legs_as_takers() -> None:
    """What generation 5 charged: 2 * (0.05 + 0.02) = 0.14% of a 100.0 entry
    over a 1.0 stop."""
    scenario = legacy_taker_scenario(costed_rows([_row()]))
    assert scenario is not None
    assert scenario.mean_cost == pytest.approx(0.14)


def test_the_legacy_scenario_is_dearer_than_every_live_exit() -> None:
    """The correction only ever reprices downward — an order that waits to be
    hit cannot cost more than one that crosses the spread."""
    legacy = legacy_taker_scenario(costed_rows([_row()]))
    assert legacy is not None
    for reason in ("invalidation", "target", "trailing_stop", "timeout"):
        assert CFG.round_trip_cost_pct(reason) < legacy.round_trip_pct, reason


def test_the_legacy_scenario_shares_the_denominator_of_the_others() -> None:
    rows = costed_rows([_row(), _row(id="2", cost_r=0.0), _row(id="3", entry_price=None)])
    legacy = legacy_taker_scenario(rows)
    live = cost_scenario(rows, "taker", 0.14)
    assert legacy is not None and live is not None
    assert legacy.n == live.n == 1


# ── rendering ────────────────────────────────────────────────────────────────


def _report() -> Report:
    arm = arm_named("no_trail")
    assert arm is not None
    result = _result(arm, 0.2, 500, 0.01)
    _judge(result)
    return Report(
        generated_at=datetime(2026, 8, 14, tzinfo=UTC),
        window_days=7,
        week_rows=700,
        total_rows=5000,
        control_week_r=-0.1,
        control_total_r=-0.15,
        results=[result],
        scenarios=[],
    )


def test_both_renderings_say_that_nothing_changed() -> None:
    """The report is evidence. If it ever reads like an action, the discipline
    it exists to enforce is already gone."""
    report = _report()
    assert "human decision" in render_markdown(report)
    assert "Nothing changed automatically" in render_telegram(report)


def test_the_telegram_rendering_stays_phone_sized() -> None:
    lines = render_telegram(_report()).splitlines()
    assert all(len(line) <= 72 for line in lines), "a wrapped line is an unread line"
