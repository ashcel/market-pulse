"""Tests for the pure risk-engine core (M9-T2 / EDR 0020 decision 2).

No DB, no network, no FastAPI app — `conftest.py` still imports `app.main`
for the shared `client` fixture, but nothing here uses it, so this file is
safe to run in isolation:

    cd backend && .venv/bin/python -m pytest tests/test_execution_risk_engine.py -q

Matrix covers the DoD's assertions:
  1. every hard check from EDR 0020 decision 2 fails independently, with a
     dedicated fixture and a typed-enum reason (never free text);
  2. several checks fail in the same decision (combination case);
  3. an APPROVED case with headroom on every check;
  4. a stale account-state input fails closed (`STALE_ACCOUNT_STATE`) even
     when every other check would otherwise pass;
  5. a purity guard: the module's own source imports nothing DB/network
     shaped and never reads a clock.
"""

import ast
import inspect
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

import pytest

from app.execution import risk_engine
from app.execution.risk_engine import (
    AccountState,
    PermitCheck,
    PermitStatus,
    TradeProposal,
    evaluate_permit,
)
from app.execution.sizing import BTCUSDT_PERP_FILTERS, Side, size_position

NOW = datetime(2026, 7, 19, 12, 0, 0)
SESSION_OK = "london"


@dataclass
class FakeConstitution:
    """Same structural role as `test_execution_constitution.py`'s
    `FakeConstitution` — a plain dataclass satisfying `ConstitutionInput`
    without a DB round trip."""

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


def base_proposal(**overrides: object) -> TradeProposal:
    defaults: dict[str, object] = dict(
        symbol="BTCUSDT",
        side=Side.LONG,
        entry_price=Decimal("65000"),
        stop_price=Decimal("64000"),
        take_profit_price=Decimal("67000"),  # rr = 2000/1000 = 2.0
        risk_percent=Decimal("1.0"),
        leverage=Decimal("2"),
        correlation_bucket="majors",
        proposed_notional_percent=Decimal("10"),
    )
    defaults.update(overrides)
    return TradeProposal(**defaults)  # type: ignore[arg-type]


def base_account(**overrides: object) -> AccountState:
    defaults: dict[str, object] = dict(
        balance=Decimal("10000"),
        open_position_count=1,
        daily_realized_pnl_percent=Decimal("0"),
        weekly_realized_pnl_percent=Decimal("0"),
        exposure_by_bucket_percent={},
        active_behavior_flags=frozenset(),
        is_stale=False,
    )
    defaults.update(overrides)
    return AccountState(**defaults)  # type: ignore[arg-type]


def result_for(
    decision: risk_engine.PermitDecision, check: PermitCheck
) -> risk_engine.PermitCheckResult:
    for result in decision.checks:
        if result.check is check:
            return result
    raise AssertionError(f"{check} missing from decision.checks")


def other_checks_pass(decision: risk_engine.PermitDecision, *excluded: PermitCheck) -> bool:
    return all(r.passed for r in decision.checks if r.check not in excluded)


# ---------------------------------------------------------------------------
# APPROVED with headroom on every check
# ---------------------------------------------------------------------------


def test_approved_with_headroom_on_every_check() -> None:
    # Derive the proposal's notional % from a real `size_position` call
    # (reusing sizing.py's Decimal-exact math rather than reinventing it),
    # then confirm the resulting proposal clears every hard check.
    sizing = size_position(
        symbol="BTCUSDT",
        side=Side.LONG,
        balance=Decimal("10000"),
        entry_price=Decimal("65000.0"),
        stop_price=Decimal("64000.0"),
        risk_fraction=Decimal("0.01"),
        filters=BTCUSDT_PERP_FILTERS,
        leverage=Decimal("2"),
    )
    assert sizing.approved is True
    # Risk-based sizing derives notional from stop distance, not leverage —
    # a modest 1%-risk position on a ~1.5%-away stop is still a large chunk
    # of a $10k account's notional. Give this fixture's constitution enough
    # correlated-exposure headroom (80% cap) to comfortably clear the
    # resulting ~65% bucket exposure while every other check still has
    # headroom too.
    notional_percent = (sizing.notional / Decimal("10000")) * 100

    proposal = base_proposal(
        entry_price=Decimal("65000.0"),
        stop_price=Decimal("64000.0"),
        take_profit_price=Decimal("67000.0"),
        leverage=Decimal("2"),
        proposed_notional_percent=notional_percent,
    )
    account = base_account()
    constitution = FakeConstitution(max_correlated_exposure_percent=80.0)

    decision = evaluate_permit(
        proposal, account, constitution, now=NOW, session=SESSION_OK
    )

    assert decision.status is PermitStatus.APPROVED
    assert decision.reasons == ()
    assert all(r.passed for r in decision.checks)
    assert {r.check for r in decision.checks} == set(PermitCheck)
    assert decision.evaluated_at is NOW
    assert decision.session == SESSION_OK


# ---------------------------------------------------------------------------
# Each rule fails independently
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("risk_percent", [Decimal("0.1"), Decimal("4.0")])
def test_risk_pct_out_of_band_fails_below_and_above_global_band(risk_percent) -> None:
    decision = evaluate_permit(
        base_proposal(risk_percent=risk_percent),
        base_account(),
        FakeConstitution(),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.RISK_PCT_OUT_OF_BAND in decision.reasons
    assert other_checks_pass(decision, PermitCheck.RISK_PCT_OUT_OF_BAND)


def test_risk_pct_out_of_band_fails_when_above_configured_value_even_if_in_global_band() -> None:
    # 2.0% is inside the global [0.5, 3.0] band but above this account's
    # configured 1.0% — a ticket can never request more than the
    # constitution allows, even within the global band.
    decision = evaluate_permit(
        base_proposal(risk_percent=Decimal("2.0")),
        base_account(),
        FakeConstitution(risk_per_trade_percent=1.0),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.RISK_PCT_OUT_OF_BAND in decision.reasons
    assert other_checks_pass(decision, PermitCheck.RISK_PCT_OUT_OF_BAND)


def test_daily_loss_limit_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(),
        base_account(daily_realized_pnl_percent=Decimal("-3.0")),
        FakeConstitution(daily_loss_limit_percent=3.0),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.DAILY_LOSS_LIMIT in decision.reasons
    assert other_checks_pass(decision, PermitCheck.DAILY_LOSS_LIMIT)


def test_weekly_loss_limit_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(),
        base_account(weekly_realized_pnl_percent=Decimal("-8.0")),
        FakeConstitution(weekly_loss_limit_percent=8.0),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.WEEKLY_LOSS_LIMIT in decision.reasons
    assert other_checks_pass(decision, PermitCheck.WEEKLY_LOSS_LIMIT)


def test_max_leverage_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(leverage=Decimal("6")),
        base_account(),
        FakeConstitution(max_leverage=5),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.MAX_LEVERAGE in decision.reasons
    assert other_checks_pass(decision, PermitCheck.MAX_LEVERAGE)


def test_max_concurrent_positions_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(),
        base_account(open_position_count=3),
        FakeConstitution(max_concurrent_positions=3),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.MAX_CONCURRENT_POSITIONS in decision.reasons
    assert other_checks_pass(decision, PermitCheck.MAX_CONCURRENT_POSITIONS)


def test_max_correlated_exposure_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(correlation_bucket="majors", proposed_notional_percent=Decimal("10")),
        base_account(exposure_by_bucket_percent={"majors": Decimal("35")}),
        FakeConstitution(max_correlated_exposure_percent=40.0),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.MAX_CORRELATED_EXPOSURE in decision.reasons
    assert other_checks_pass(decision, PermitCheck.MAX_CORRELATED_EXPOSURE)


def test_rr_below_min_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(take_profit_price=Decimal("65500")),  # rr = 500/1000 = 0.5
        base_account(),
        FakeConstitution(min_risk_reward=1.5),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.RR_BELOW_MIN in decision.reasons
    assert other_checks_pass(decision, PermitCheck.RR_BELOW_MIN)


def test_stop_missing_fails_independently_and_does_not_also_fail_rr() -> None:
    decision = evaluate_permit(
        base_proposal(stop_price=None),
        base_account(),
        FakeConstitution(),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.STOP_MISSING in decision.reasons
    # RR_BELOW_MIN is a distinct rule with its own dedicated fixture above;
    # a missing stop must not silently double-count as an RR failure too.
    assert result_for(decision, PermitCheck.RR_BELOW_MIN).passed is True
    assert other_checks_pass(decision, PermitCheck.STOP_MISSING)


def test_symbol_not_allowed_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(symbol="DOGEUSDT"),
        base_account(),
        FakeConstitution(allowed_symbols=["BTCUSDT", "ETHUSDT"]),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.SYMBOL_NOT_ALLOWED in decision.reasons
    assert other_checks_pass(decision, PermitCheck.SYMBOL_NOT_ALLOWED)


def test_symbol_allow_list_empty_means_unrestricted() -> None:
    decision = evaluate_permit(
        base_proposal(symbol="DOGEUSDT"),
        base_account(),
        FakeConstitution(allowed_symbols=[]),
        now=NOW,
        session=SESSION_OK,
    )
    assert result_for(decision, PermitCheck.SYMBOL_NOT_ALLOWED).passed is True


def test_session_not_allowed_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(),
        base_account(),
        FakeConstitution(allowed_sessions=["london", "new_york"]),
        now=NOW,
        session="asia",
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.SESSION_NOT_ALLOWED in decision.reasons
    assert other_checks_pass(decision, PermitCheck.SESSION_NOT_ALLOWED)


def test_stale_account_state_fails_closed_even_with_full_headroom() -> None:
    """DoD: a stale-account-state input yields STALE_ACCOUNT_STATE REJECTED
    even though every other check, given these inputs, would pass."""
    decision = evaluate_permit(
        base_proposal(),
        base_account(is_stale=True),
        FakeConstitution(),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert decision.reasons == (PermitCheck.STALE_ACCOUNT_STATE,)
    assert other_checks_pass(decision, PermitCheck.STALE_ACCOUNT_STATE)


def test_binding_cooldown_active_fails_independently() -> None:
    decision = evaluate_permit(
        base_proposal(),
        base_account(active_behavior_flags=frozenset({"revenge"})),
        FakeConstitution(binding_cooldowns={"revenge": True, "overtrading": False}),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.BINDING_COOLDOWN_ACTIVE in decision.reasons
    assert other_checks_pass(decision, PermitCheck.BINDING_COOLDOWN_ACTIVE)


def test_advisory_only_behavior_flag_does_not_bind() -> None:
    """A detector flag not opted into `binding_cooldowns` (or opted in as
    False) is advisory-only — it must not reject the permit."""
    decision = evaluate_permit(
        base_proposal(),
        base_account(active_behavior_flags=frozenset({"overtrading"})),
        FakeConstitution(binding_cooldowns={"revenge": True, "overtrading": False}),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.APPROVED
    assert result_for(decision, PermitCheck.BINDING_COOLDOWN_ACTIVE).passed is True


# ---------------------------------------------------------------------------
# Several rules fail in combination
# ---------------------------------------------------------------------------


def test_multiple_rules_fail_in_combination() -> None:
    decision = evaluate_permit(
        base_proposal(
            leverage=Decimal("10"),  # > max 5
            proposed_notional_percent=Decimal("50"),  # + 0 current > max 40
            take_profit_price=Decimal("65200"),  # rr = 200/1000 = 0.2 < 1.5
        ),
        base_account(
            daily_realized_pnl_percent=Decimal("-3.5"),  # >= 3.0 limit
            is_stale=True,
        ),
        FakeConstitution(),
        now=NOW,
        session="asia",  # not in allow-list
    )

    assert decision.status is PermitStatus.REJECTED
    expected_failures = {
        PermitCheck.DAILY_LOSS_LIMIT,
        PermitCheck.MAX_LEVERAGE,
        PermitCheck.MAX_CORRELATED_EXPOSURE,
        PermitCheck.RR_BELOW_MIN,
        PermitCheck.SESSION_NOT_ALLOWED,
        PermitCheck.STALE_ACCOUNT_STATE,
    }
    assert set(decision.reasons) == expected_failures
    # Untouched rules in this combination still pass on their own.
    still_passing = {
        PermitCheck.RISK_PCT_OUT_OF_BAND,
        PermitCheck.WEEKLY_LOSS_LIMIT,
        PermitCheck.MAX_CONCURRENT_POSITIONS,
        PermitCheck.STOP_MISSING,
        PermitCheck.SYMBOL_NOT_ALLOWED,
        PermitCheck.BINDING_COOLDOWN_ACTIVE,
    }
    for check in still_passing:
        assert result_for(decision, check).passed is True


def test_reasons_are_reported_in_fixed_check_order() -> None:
    decision = evaluate_permit(
        base_proposal(leverage=Decimal("10"), symbol="DOGEUSDT"),
        base_account(is_stale=True),
        FakeConstitution(),
        now=NOW,
        session=SESSION_OK,
    )
    order = [c for c in risk_engine.CHECK_ORDER if c in decision.reasons]
    assert list(decision.reasons) == order


# ---------------------------------------------------------------------------
# Fail-closed / unflippable-rejection guarantees
# ---------------------------------------------------------------------------


def test_no_override_parameter_exists_on_evaluate_permit() -> None:
    """A `REJECTED` decision must be unflippable: there is no argument to
    `evaluate_permit` that could bypass a failed hard check."""
    params = set(inspect.signature(evaluate_permit).parameters)
    assert params == {"proposal", "account_state", "constitution", "now", "session"}


def test_rejected_status_only_when_a_check_failed() -> None:
    decision = evaluate_permit(
        base_proposal(leverage=Decimal("6")),
        base_account(),
        FakeConstitution(max_leverage=5),
        now=NOW,
        session=SESSION_OK,
    )
    assert decision.status is PermitStatus.REJECTED
    assert any(not r.passed for r in decision.checks)


# ---------------------------------------------------------------------------
# Purity guard — no DB/network import, no clock read, inside the module
# ---------------------------------------------------------------------------

_FORBIDDEN_IMPORT_ROOTS = {
    "sqlalchemy",
    "asyncpg",
    "psycopg",
    "psycopg2",
    "httpx",
    "requests",
    "aiohttp",
    "socket",
    "urllib",
    "app.database",
    "app.execution.models",
    "app.execution.service",
    "app.execution.schemas",
    "app.main",
}


def _imported_roots(tree: ast.Module) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module)
    return roots


def test_module_imports_nothing_db_or_network_shaped() -> None:
    source = inspect.getsource(risk_engine)
    tree = ast.parse(source)
    imported = _imported_roots(tree)

    offending = {
        root
        for root in imported
        if any(
            root == forbidden or root.startswith(forbidden + ".")
            for forbidden in _FORBIDDEN_IMPORT_ROOTS
        )
    }
    assert not offending, f"risk_engine.py imports forbidden module(s): {offending}"


def test_module_never_reads_the_clock_or_touches_io() -> None:
    """AST-based (not substring) so mentioning `datetime.now()` in a
    docstring/comment — as this module's own module docstring does, to
    explain the guarantee — can never produce a false positive."""
    source = inspect.getsource(risk_engine)
    tree = ast.parse(source)

    clock_read_attrs = {"now", "utcnow", "today"}
    clock_read_owners = {"datetime", "time", "date"}

    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef):
            pytest.fail(f"risk_engine.py defines an async function: {node.name}")
        if isinstance(node, ast.Await):
            pytest.fail("risk_engine.py contains an `await` expression")
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id == "open":
                pytest.fail("risk_engine.py calls the builtin `open()`")
            if (
                isinstance(func, ast.Attribute)
                and func.attr in clock_read_attrs
                and isinstance(func.value, ast.Name)
                and func.value.id in clock_read_owners
            ):
                pytest.fail(f"risk_engine.py reads the clock via {func.value.id}.{func.attr}()")


def test_evaluate_permit_is_a_plain_sync_function_with_no_side_effect_signature() -> None:
    assert not inspect.iscoroutinefunction(evaluate_permit)
    assert not inspect.isgeneratorfunction(evaluate_permit)
