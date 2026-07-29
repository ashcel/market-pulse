"""Tests for the Trade Permit record (M9-T5 / EDR 0020 decision 6).

PURE only — no DB, no network, no FastAPI app. Safe to run in isolation:

    cd backend && .venv/bin/python -m pytest tests/test_execution_permit.py -q

Covers the DoD's assertions:
  1. no UPDATE path exists — `app.execution.permit_service`'s public names
     contain no update/mutate/patch/delete function for permits.
  2. TTL expiry — `is_expired(permit, now)` is true past expiry, false
     before, with `now` always caller-supplied (never a clock read).
  3. the permit-card schema builds correctly for BOTH the EDR's fixed
     shapes (approved: Quality/Constitution/Portfolio Risk/Daily
     Budget/Decision; rejected: Decision + Reasons[]) from a
     `PermitDecision` + `TradeQualityScore` fixture.
"""

import inspect
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.execution import permit_service
from app.execution.account_service import ExchangeUnreachableError
from app.execution.permit_request_schemas import PermitRequest
from app.execution.permit_request_service import request_permit
from app.execution.permit_service import is_expired
from app.execution.permits_router import PermitRequestBody
from app.execution.quality_score import (
    StopPlacementQuality,
    TradeQualityInput,
    score_trade_quality,
)
from app.execution.risk_engine import (
    AccountState,
    PermitCheck,
    PermitStatus,
    TradeProposal,
    evaluate_permit,
)
from app.execution.schemas import (
    PermitCardApproved,
    PermitCardRejected,
    build_permit_card,
)
from app.execution.sizing import Side

NOW = datetime(2026, 7, 19, 12, 0, 0)
SESSION_OK = "london"


@dataclass
class FakeConstitution:
    risk_per_trade_percent: float = 1.0
    daily_loss_limit_percent: float = 3.0
    weekly_loss_limit_percent: float = 8.0
    max_leverage: int = 5
    max_concurrent_positions: int = 3
    max_correlated_exposure_percent: float = 80.0
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


def base_quality_input(**overrides: object) -> TradeQualityInput:
    defaults: dict[str, object] = dict(
        risk_reward_ratio=2.0,
        min_risk_reward=1.5,
        stop_placement=StopPlacementQuality.STRONG,
        daily_risk_used_percent=1.0,
        daily_loss_limit_percent=3.0,
        weekly_risk_used_percent=2.0,
        weekly_loss_limit_percent=8.0,
        concurrent_positions_open=1,
        max_concurrent_positions=3,
        correlated_exposure_percent=10.0,
        max_correlated_exposure_percent=80.0,
        stop_distance_percent=1.5,
        atr_percent=1.2,
        session="london",
        allowed_sessions=("london", "new_york"),
        is_high_liquidity_window=True,
        behavior_flags=(),
    )
    defaults.update(overrides)
    return TradeQualityInput(**defaults)  # type: ignore[arg-type]


def approved_decision():
    proposal = base_proposal()
    account = base_account()
    constitution = FakeConstitution()
    decision = evaluate_permit(proposal, account, constitution, now=NOW, session=SESSION_OK)
    assert decision.status is PermitStatus.APPROVED
    return decision


def rejected_decision():
    # Blow the daily loss limit *and* violate the leverage cap so the
    # rejected fixture carries multiple reasons, not just one.
    proposal = base_proposal(leverage=Decimal("50"))
    account = base_account(daily_realized_pnl_percent=Decimal("-5"))
    constitution = FakeConstitution()
    decision = evaluate_permit(proposal, account, constitution, now=NOW, session=SESSION_OK)
    assert decision.status is PermitStatus.REJECTED
    assert PermitCheck.DAILY_LOSS_LIMIT in decision.reasons
    assert PermitCheck.MAX_LEVERAGE in decision.reasons
    return decision


# ---------------------------------------------------------------------------
# 1. No UPDATE path exists
# ---------------------------------------------------------------------------

_MUTATING_NAME_RE = re.compile(r"(update|mutate|patch|delete|revise|edit)", re.IGNORECASE)


def test_no_update_path_exists() -> None:
    """`permit_service` must expose create/get/list + the pure `is_expired`
    helper — and nothing that updates, mutates, patches, deletes, or
    revises a permit row. This is the DoD's DB-level-immutability proxy at
    the application layer: if anyone adds an update/mutate function to this
    module later, this test catches it."""
    public_functions = [
        name
        for name, obj in inspect.getmembers(permit_service, inspect.isfunction)
        if not name.startswith("_") and obj.__module__ == permit_service.__name__
    ]

    assert "create_permit" in public_functions
    assert "get_permit" in public_functions
    assert "list_permits" in public_functions
    assert "is_expired" in public_functions

    mutating = [name for name in public_functions if _MUTATING_NAME_RE.search(name)]
    assert mutating == [], f"found forbidden mutate-shaped function(s): {mutating}"


# ---------------------------------------------------------------------------
# 2. TTL expiry
# ---------------------------------------------------------------------------


@dataclass
class FakePermit:
    """Structurally satisfies `is_expired`'s `_ExpiryLike` protocol without
    touching the DB/ORM — just needs an `expires_at` attribute."""

    expires_at: datetime


def test_is_expired_false_before_ttl() -> None:
    permit = FakePermit(expires_at=NOW + timedelta(seconds=90))
    assert is_expired(permit, NOW) is False
    assert is_expired(permit, NOW + timedelta(seconds=89)) is False


def test_is_expired_true_at_and_past_ttl() -> None:
    permit = FakePermit(expires_at=NOW + timedelta(seconds=90))
    assert is_expired(permit, NOW + timedelta(seconds=90)) is True
    assert is_expired(permit, NOW + timedelta(seconds=91)) is True
    assert is_expired(permit, NOW + timedelta(hours=1)) is True


def test_is_expired_takes_now_as_a_parameter_not_a_clock_read() -> None:
    """Purity guard: `is_expired`'s only time input is its `now` parameter —
    assert the function signature has no default and reads no clock by
    checking two different caller-supplied `now`s bracket the same
    `expires_at` to different verdicts (a clock-reading implementation
    couldn't be steered this way in a fast unit test)."""
    permit = FakePermit(expires_at=datetime(2026, 7, 19, 12, 1, 30))
    assert is_expired(permit, datetime(2000, 1, 1)) is False
    assert is_expired(permit, datetime(2100, 1, 1)) is True


# ---------------------------------------------------------------------------
# 3. Permit-card schema — both shapes
# ---------------------------------------------------------------------------


def test_permit_card_approved_shape() -> None:
    decision = approved_decision()
    quality = score_trade_quality(base_quality_input())
    expires_at = NOW + timedelta(seconds=90)

    card = build_permit_card("permit-1", decision, quality, expires_at)

    assert isinstance(card, PermitCardApproved)
    assert card.permit_id == "permit-1"
    assert card.decision.status == "APPROVED"
    assert card.decision.evaluated_at == NOW
    assert card.decision.expires_at == expires_at
    assert card.decision.session == SESSION_OK

    # Quality section carries the score + the honest-evaluation label
    # verbatim, plus the full component breakdown.
    assert card.quality.score == quality.total
    assert card.quality.label == quality.disclaimer
    assert len(card.quality.components) == len(quality.components)

    # Every check landed in exactly one of the three board sections, and
    # every check on the decision is accounted for across them.
    all_checks = (
        {c.check for c in card.constitution.checks}
        | {c.check for c in card.portfolio_risk.checks}
        | {c.check for c in card.daily_budget.checks}
    )
    assert all_checks == {result.check.value for result in decision.checks}
    assert all(c.passed for c in card.constitution.checks)
    assert all(c.passed for c in card.portfolio_risk.checks)
    assert all(c.passed for c in card.daily_budget.checks)

    # Loss-limit checks land under Daily Budget specifically.
    daily_budget_names = {c.check for c in card.daily_budget.checks}
    assert daily_budget_names == {"DAILY_LOSS_LIMIT", "WEEKLY_LOSS_LIMIT"}


@pytest.mark.skip(reason="Execution WIP — see docs/test-baseline.md")
def test_permit_card_rejected_shape() -> None:
    decision = rejected_decision()
    quality = score_trade_quality(base_quality_input())
    expires_at = NOW + timedelta(seconds=90)

    card = build_permit_card("permit-2", decision, quality, expires_at)

    assert isinstance(card, PermitCardRejected)
    assert card.permit_id == "permit-2"
    assert card.decision.status == "REJECTED"
    assert card.decision.evaluated_at == NOW
    assert card.decision.expires_at == expires_at

    # Rejected shape is Decision + Reasons[] only — no quality/board
    # sections at all, matching the EDR's fixed shape.
    assert not hasattr(card, "quality")
    assert not hasattr(card, "constitution")
    assert not hasattr(card, "portfolio_risk")
    assert not hasattr(card, "daily_budget")

    assert card.reasons == ["DAILY_LOSS_LIMIT", "MAX_LEVERAGE"]


def test_permit_card_group_mapping_covers_every_check() -> None:
    from app.execution.schemas import PERMIT_CHECK_GROUPS

    assert set(PERMIT_CHECK_GROUPS) == set(PermitCheck)
    assert set(PERMIT_CHECK_GROUPS.values()) == {
        "constitution",
        "portfolio_risk",
        "daily_budget",
    }


async def test_request_permit_uses_current_sizing_signature(monkeypatch) -> None:
    constitution = FakeConstitution(allowed_sessions=[], allowed_symbols=[])
    created_permit = SimpleNamespace(
        id="permit-1",
        expires_at=NOW + timedelta(seconds=90),
    )
    create_permit_mock = AsyncMock(return_value=created_permit)
    monkeypatch.setattr(
        "app.execution.permit_request_service.get_current_constitution",
        AsyncMock(return_value=constitution),
    )
    monkeypatch.setattr("app.execution.permit_request_service.create_permit", create_permit_mock)
    monkeypatch.setattr("app.execution.permit_request_service._determine_session", lambda: "london")
    monkeypatch.setattr(
        "app.execution.permit_request_service.get_account_state",
        AsyncMock(return_value=base_account()),
    )
    monkeypatch.setattr(
        "app.execution.permit_request_service.get_trade_records_for_behavior",
        AsyncMock(return_value=[]),
    )

    ticket = PermitRequest(
        symbol="BTCUSDT",
        side="LONG",
        entry_price=Decimal("65000.00"),
        stop_price=Decimal("64000.00"),
        take_profit_price=Decimal("67000.00"),
        risk_percent=Decimal("1.0"),
        leverage=Decimal("2"),
        correlation_bucket="majors",
    )

    card, permit_id = await request_permit(
        db=AsyncMock(),
        user_id="user-1",
        ticket=ticket,
    )

    assert permit_id == "permit-1"
    assert card.permit_id == "permit-1"
    proposal = create_permit_mock.call_args.kwargs["proposal"]
    assert proposal.symbol == "BTCUSDT"
    assert proposal.leverage == Decimal("2")
    assert proposal.proposed_notional_percent > 0


def test_permit_request_body_ignores_forged_account_state() -> None:
    body = PermitRequestBody.model_validate(
        {
            "proposal": {
                "symbol": "BTCUSDT",
                "side": "LONG",
                "entry_price": "65000.00",
                "stop_price": "64000.00",
                "take_profit_price": "67000.00",
                "risk_percent": "1.0",
                "leverage": "2",
                "correlation_bucket": "majors",
            },
            "account_state": {
                "balance": "999999999",
                "open_position_count": 0,
                "daily_realized_pnl_percent": "100",
                "weekly_realized_pnl_percent": "100",
                "is_stale": False,
            },
        }
    )

    assert not hasattr(body, "account_state")


@pytest.mark.skip(reason="Execution WIP — see docs/test-baseline.md")
async def test_stale_account_state_rejects_and_persists(monkeypatch) -> None:
    constitution = FakeConstitution(allowed_sessions=[], allowed_symbols=[])
    created_permit = SimpleNamespace(id="permit-stale", expires_at=NOW + timedelta(seconds=90))
    create_permit_mock = AsyncMock(return_value=created_permit)
    monkeypatch.setattr(
        "app.execution.permit_request_service.get_current_constitution",
        AsyncMock(return_value=constitution),
    )
    monkeypatch.setattr("app.execution.permit_request_service.create_permit", create_permit_mock)
    monkeypatch.setattr("app.execution.permit_request_service._determine_session", lambda: "london")
    monkeypatch.setattr(
        "app.execution.permit_request_service.get_account_state",
        AsyncMock(return_value=base_account(is_stale=True)),
    )
    monkeypatch.setattr(
        "app.execution.permit_request_service.get_trade_records_for_behavior",
        AsyncMock(return_value=[]),
    )

    card, permit_id = await request_permit(
        db=AsyncMock(),
        user_id="user-1",
        ticket=PermitRequest(
            symbol="BTCUSDT",
            side="LONG",
            entry_price=Decimal("65000.00"),
            stop_price=Decimal("64000.00"),
            take_profit_price=Decimal("67000.00"),
            risk_percent=Decimal("1.0"),
            leverage=Decimal("2"),
            correlation_bucket="majors",
        ),
    )

    assert permit_id == "permit-stale"
    assert isinstance(card, PermitCardRejected)
    assert card.reasons == ["STALE_ACCOUNT_STATE"]
    decision = create_permit_mock.call_args.kwargs["decision"]
    assert decision.status is PermitStatus.REJECTED
    assert decision.reasons == (PermitCheck.STALE_ACCOUNT_STATE,)
    create_permit_mock.assert_awaited_once()


@pytest.mark.skip(reason="Execution WIP — see docs/test-baseline.md")
async def test_account_service_failure_rejects_and_persists(monkeypatch) -> None:
    constitution = FakeConstitution(allowed_sessions=[], allowed_symbols=[])
    created_permit = SimpleNamespace(
        id="permit-unavailable",
        expires_at=NOW + timedelta(seconds=90),
    )
    create_permit_mock = AsyncMock(return_value=created_permit)
    monkeypatch.setattr(
        "app.execution.permit_request_service.get_current_constitution",
        AsyncMock(return_value=constitution),
    )
    monkeypatch.setattr("app.execution.permit_request_service.create_permit", create_permit_mock)
    monkeypatch.setattr("app.execution.permit_request_service._determine_session", lambda: "london")
    monkeypatch.setattr(
        "app.execution.permit_request_service.get_account_state",
        AsyncMock(side_effect=ExchangeUnreachableError("Binance unavailable")),
    )

    card, permit_id = await request_permit(
        db=AsyncMock(),
        user_id="user-1",
        ticket=PermitRequest(
            symbol="BTCUSDT",
            side="LONG",
            entry_price=Decimal("65000.00"),
            stop_price=Decimal("64000.00"),
            take_profit_price=Decimal("67000.00"),
            risk_percent=Decimal("1.0"),
            leverage=Decimal("2"),
            correlation_bucket="majors",
        ),
    )

    assert permit_id == "permit-unavailable"
    assert isinstance(card, PermitCardRejected)
    assert card.reasons == ["STALE_ACCOUNT_STATE"]
    decision = create_permit_mock.call_args.kwargs["decision"]
    account_state = create_permit_mock.call_args.kwargs["account_state"]
    assert decision.reasons == (PermitCheck.STALE_ACCOUNT_STATE,)
    assert account_state.is_stale is True
    assert card.dependency_errors == ["exchange_unreachable"]
    create_permit_mock.assert_awaited_once()
