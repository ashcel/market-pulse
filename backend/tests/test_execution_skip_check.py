"""Pure tests for the Skip Check classifier — R2 (EDR 0022 decision 5).

No DB, no network, no clock: every test drives the pure
`skip_check_service.build_skip_answer` with deterministic inputs (a real
`PermitDecision` from `evaluate_permit`, a real `SizingResult` from
`size_position`), and asserts the typed contract + the three answer shapes.

    cd backend && .venv/bin/python -m pytest tests/test_execution_skip_check.py -q
"""

import ast
import inspect
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from app.execution.quality_score import score_trade_quality
from app.execution.risk_engine import (
    AccountState,
    PermitStatus,
    TradeProposal,
    evaluate_permit,
)
from app.execution.sizing import BTCUSDT_PERP_FILTERS, Side, size_position
from app.execution.skip_check_schemas import (
    BlockStatus,
    SkipAnswer,
    SkipBlockKind,
    SkipCode,
    SkipDirection,
    SkipObjective,
    VerdictContextInput,
    VerdictState,
)
from app.execution.skip_check_service import CatalystInfo, build_skip_answer

NOW = datetime(2026, 7, 24, 12, 0, 0)
SESSION_OK = "london"


@dataclass
class FakeConstitution:
    risk_per_trade_percent: float = 1.0
    daily_loss_limit_percent: float = 3.0
    weekly_loss_limit_percent: float = 8.0
    max_leverage: int = 5
    max_concurrent_positions: int = 3
    max_correlated_exposure_percent: float = 40.0
    min_risk_reward: float = 1.5
    allowed_sessions: list[str] = field(default_factory=lambda: ["london", "new_york"])
    allowed_symbols: list[str] = field(default_factory=lambda: ["BTCUSDT", "ETHUSDT"])
    binding_cooldowns: dict[str, bool] = field(
        default_factory=lambda: {"revenge": True, "overtrading": False}
    )


def _account(**overrides) -> AccountState:
    defaults = dict(
        balance=Decimal("10000"),
        open_position_count=1,
        daily_realized_pnl_percent=Decimal("0"),
        weekly_realized_pnl_percent=Decimal("0"),
        exposure_by_bucket_percent={},
        active_behavior_flags=frozenset(),
        is_stale=False,
    )
    defaults.update(overrides)
    return AccountState(**defaults)


def _sizing(leverage="2"):
    return size_position(
        symbol="BTCUSDT",
        side=Side.LONG,
        balance=Decimal("10000"),
        entry_price=Decimal("65000"),
        stop_price=Decimal("64000"),
        risk_fraction=Decimal("0.01"),
        filters=BTCUSDT_PERP_FILTERS,
        leverage=Decimal(leverage),
    )


def _proposal(sizing, **overrides) -> TradeProposal:
    defaults = dict(
        symbol="BTCUSDT",
        side=Side.LONG,
        entry_price=Decimal("65000"),
        stop_price=Decimal("64000"),
        take_profit_price=Decimal("67000"),  # rr = 2.0
        risk_percent=Decimal("1.0"),
        leverage=Decimal("2"),
        correlation_bucket="btc",
        proposed_notional_percent=Decimal("10"),
        liquidation_price=sizing.liquidation_price if sizing else None,
        margin_type="ISOLATED",
    )
    defaults.update(overrides)
    return TradeProposal(**defaults)


def _decision(proposal, account, constitution=None):
    return evaluate_permit(
        proposal=proposal,
        account_state=account,
        constitution=constitution or FakeConstitution(),
        now=NOW,
        session=SESSION_OK,
    )


def _quality(constitution=None):
    con = constitution or FakeConstitution()
    from app.execution.quality_score import StopPlacementQuality, TradeQualityInput

    return score_trade_quality(
        TradeQualityInput(
            risk_reward_ratio=2.0,
            min_risk_reward=con.min_risk_reward,
            stop_placement=StopPlacementQuality.ADEQUATE,
            daily_risk_used_percent=0.0,
            daily_loss_limit_percent=con.daily_loss_limit_percent,
            weekly_risk_used_percent=0.0,
            weekly_loss_limit_percent=con.weekly_loss_limit_percent,
            concurrent_positions_open=1,
            max_concurrent_positions=con.max_concurrent_positions,
            correlated_exposure_percent=0.0,
            max_correlated_exposure_percent=con.max_correlated_exposure_percent,
            stop_distance_percent=1.5,
            atr_percent=1.0,
            session=SESSION_OK,
            allowed_sessions=tuple(con.allowed_sessions),
            is_high_liquidity_window=True,
            behavior_flags=(),
        )
    )


# ── shape 1: SUPPORTIVE ─────────────────────────────────────────────────────


def test_supportive_read_shape():
    sizing = _sizing()
    account = _account()
    decision = _decision(_proposal(sizing), account)
    assert decision.status is PermitStatus.APPROVED

    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.SWING,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=_quality(),
        account_stale=False,
        behavior_flags=frozenset(),
        binding_cooldowns={"revenge": True},
        verdict=VerdictContextInput(state=VerdictState.LIVE, regime_aligned=True),
        catalyst=CatalystInfo(title="none", impact="low", direction="neutral", hours_until=0.0),
        sizing=sizing,
        stop_provided=True,
        target_provided=True,
        price_available=True,
        leverage=Decimal("2"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )

    assert answer.answer is SkipAnswer.SUPPORTIVE
    assert answer.viable is True
    assert answer.cautions == []
    # verdict-live is a supportive block
    kinds = {b.kind for b in answer.supportive_read}
    assert SkipBlockKind.OBJECTIVE_FIT in kinds
    assert SkipBlockKind.CONSTITUTION_HEADROOM in kinds
    assert answer.permit_preview.status == "APPROVED"
    assert answer.sizing.available is True
    assert answer.sizing.max_risk_percent_at_leverage is not None
    # what-flips-it is always present, even on a clean supportive read
    assert len(answer.what_flips_it) >= 1


# ── shape 2: CAUTION (blocking) ─────────────────────────────────────────────


def test_caution_shape_daily_loss_blocking():
    sizing = _sizing()
    account = _account(daily_realized_pnl_percent=Decimal("-3.5"))  # over the 3% limit
    decision = _decision(_proposal(sizing), account)
    assert decision.status is PermitStatus.REJECTED

    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.INTRADAY,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=_quality(),
        account_stale=False,
        behavior_flags=frozenset(),
        binding_cooldowns={"revenge": True},
        verdict=VerdictContextInput(state=VerdictState.LIVE, regime_aligned=True),
        catalyst=None,
        sizing=sizing,
        stop_provided=True,
        target_provided=True,
        price_available=True,
        leverage=Decimal("2"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )

    assert answer.answer is SkipAnswer.CAUTION
    assert answer.viable is False  # blocking caution
    loss_blocks = [b for b in answer.cautions if b.kind is SkipBlockKind.LOSS_BUDGET]
    assert loss_blocks and loss_blocks[0].blocking is True
    assert loss_blocks[0].code is SkipCode.LOSS_BUDGET_EXHAUSTED
    # what-flips-it names the loss-budget reset
    assert any(f.kind is SkipBlockKind.LOSS_BUDGET for f in answer.what_flips_it)


def test_caution_advisory_behavior_is_non_blocking_and_viable():
    sizing = _sizing()
    account = _account(active_behavior_flags=frozenset({"overtrading"}))
    decision = _decision(_proposal(sizing), account)

    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.SCALP,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=_quality(),
        account_stale=False,
        behavior_flags=frozenset({"overtrading"}),
        binding_cooldowns={"overtrading": False},  # advisory, not binding
        verdict=VerdictContextInput(state=VerdictState.LIVE, regime_aligned=True),
        catalyst=None,
        sizing=sizing,
        stop_provided=True,
        target_provided=True,
        price_available=True,
        leverage=Decimal("2"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )
    assert answer.answer is SkipAnswer.CAUTION
    assert answer.viable is True  # advisory only — still tradeable with eyes open
    bh = [b for b in answer.cautions if b.kind is SkipBlockKind.BEHAVIOR]
    assert bh and bh[0].blocking is False and bh[0].code is SkipCode.BEHAVIOR_ADVISORY


# ── shape 3: NO_OPINION ─────────────────────────────────────────────────────


def test_no_opinion_shape_no_stop_no_verdict():
    account = _account()
    # No stop → STOP_MISSING makes the permit REJECTED, but that is NOT a
    # viability blocker for skip check (the stop is set in the ticket).
    proposal = _proposal(
        None, stop_price=None, take_profit_price=None, liquidation_price=None
    )
    decision = _decision(proposal, account)

    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.SWING,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=_quality(),
        account_stale=False,
        behavior_flags=frozenset(),
        binding_cooldowns={},
        verdict=None,  # no engine verdict supplied
        catalyst=None,
        sizing=None,
        stop_provided=False,
        target_provided=False,
        price_available=True,
        leverage=Decimal("1"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )

    assert answer.answer is SkipAnswer.NO_OPINION
    assert answer.viable is True  # can still build a ticket to set the stop
    codes = {b.code for b in answer.no_opinion}
    assert SkipCode.STOP_NOT_PROVIDED in codes
    assert SkipCode.NO_VERDICT_SUPPLIED in codes
    # "no opinion — insufficient evidence" is first-class in its own bucket
    assert all(b.status is BlockStatus.NO_OPINION for b in answer.no_opinion)
    assert "No opinion" in answer.headline


def test_price_unavailable_is_not_viable():
    account = _account()
    proposal = _proposal(None, entry_price=Decimal("0"), stop_price=None, take_profit_price=None,
                         liquidation_price=None)
    decision = _decision(proposal, account)
    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.INTRADAY,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=None,
        account_stale=False,
        behavior_flags=frozenset(),
        binding_cooldowns={},
        verdict=None,
        catalyst=None,
        sizing=None,
        stop_provided=False,
        target_provided=False,
        price_available=False,
        leverage=Decimal("1"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )
    assert answer.viable is False
    assert any(b.code is SkipCode.PRICE_UNAVAILABLE for b in answer.no_opinion)


# ── catalyst window classification ──────────────────────────────────────────


def test_adverse_catalyst_is_a_caution():
    sizing = _sizing()
    account = _account()
    decision = _decision(_proposal(sizing), account)
    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.SWING,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=_quality(),
        account_stale=False,
        behavior_flags=frozenset(),
        binding_cooldowns={},
        verdict=VerdictContextInput(state=VerdictState.LIVE, regime_aligned=True),
        catalyst=CatalystInfo(
            title="Token unlock", impact="high", direction="bearish", hours_until=30.0
        ),
        sizing=sizing,
        stop_provided=True,
        target_provided=True,
        price_available=True,
        leverage=Decimal("2"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )
    cat = [b for b in answer.cautions if b.kind is SkipBlockKind.CATALYST_WINDOW]
    assert cat and cat[0].code is SkipCode.ADVERSE_CATALYST
    assert answer.answer is SkipAnswer.CAUTION
    assert answer.catalyst_available is True


def test_catalyst_omitted_when_events_unreachable():
    sizing = _sizing()
    account = _account()
    decision = _decision(_proposal(sizing), account)
    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.SWING,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=_quality(),
        account_stale=False,
        behavior_flags=frozenset(),
        binding_cooldowns={},
        verdict=VerdictContextInput(state=VerdictState.LIVE, regime_aligned=True),
        catalyst=None,  # events plane unreachable
        sizing=sizing,
        stop_provided=True,
        target_provided=True,
        price_available=True,
        leverage=Decimal("2"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )
    assert answer.catalyst_available is False
    assert all(b.kind is not SkipBlockKind.CATALYST_WINDOW for b in answer.supportive_read)
    assert all(b.kind is not SkipBlockKind.CATALYST_WINDOW for b in answer.cautions)


# ── liquidation-inside-stop caution ─────────────────────────────────────────


def test_liquidation_inside_stop_is_a_caution():
    # High leverage pushes liquidation inside the stop.
    sizing = _sizing(leverage="50")
    account = _account()
    con = FakeConstitution(max_leverage=125)
    proposal = _proposal(sizing, leverage=Decimal("50"))
    decision = _decision(proposal, account, con)
    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.SCALP,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=_quality(con),
        account_stale=False,
        behavior_flags=frozenset(),
        binding_cooldowns={},
        verdict=VerdictContextInput(state=VerdictState.LIVE, regime_aligned=True),
        catalyst=None,
        sizing=sizing,
        stop_provided=True,
        target_provided=True,
        price_available=True,
        leverage=Decimal("50"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )
    liq = [b for b in answer.cautions if b.kind is SkipBlockKind.LIQUIDATION_BUFFER]
    assert liq and liq[0].code is SkipCode.LIQ_INSIDE_STOP


# ── contract invariants ─────────────────────────────────────────────────────


def test_every_block_is_typed_and_what_flips_it_always_present():
    account = _account()
    proposal = _proposal(None, stop_price=None, take_profit_price=None, liquidation_price=None)
    decision = _decision(proposal, account)
    answer = build_skip_answer(
        symbol="BTCUSDT",
        objective=SkipObjective.SWING,
        direction=SkipDirection.LONG,
        decision=decision,
        quality=None,
        account_stale=False,
        behavior_flags=frozenset(),
        binding_cooldowns={},
        verdict=None,
        catalyst=None,
        sizing=None,
        stop_provided=False,
        target_provided=False,
        price_available=True,
        leverage=Decimal("1"),
        risk_percent=Decimal("1.0"),
        now=NOW,
    )
    all_blocks = answer.supportive_read + answer.cautions + answer.no_opinion
    for b in all_blocks:
        assert isinstance(b.kind, SkipBlockKind)
        assert isinstance(b.code, SkipCode)
        assert isinstance(b.status, BlockStatus)
    assert len(answer.what_flips_it) >= 1


def test_classifier_is_pure_no_io_or_clock():
    """AST guard: build_skip_answer + its helpers read no clock and open no
    socket/DB — the pure classifier is honesty-critical."""
    src = inspect.getsource(build_skip_answer)
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in {"now", "utcnow", "today"}:
            raise AssertionError(f"clock read in pure classifier: {node.attr}")
    assert "datetime.now" not in src
    assert "await" not in src
