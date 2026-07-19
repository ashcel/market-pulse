from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.execution.behavior_detectors import (
    TradeRecord,
    detect_overtrading,
    detect_revenge,
    detect_tilt,
    evaluate_behavior_flags,
)
from app.execution.risk_engine import AccountState, TradeProposal, evaluate_permit
from app.execution.sizing import Side


@pytest.fixture
def now() -> datetime:
    return datetime(2025, 1, 1, 12, 0, 0)

def test_revenge_detected_when_loss_followed_by_larger_reentry(now: datetime) -> None:
    trades = [
        TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=60),
            closed_at=now - timedelta(minutes=10),
            realized_pnl=Decimal("-100"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ),
        TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=5),
            closed_at=datetime.max,
            realized_pnl=Decimal("0"),
            notional_size=Decimal("2000"),
            risk_percent=Decimal("2"),
            side="LONG"
        )
    ]
    assert detect_revenge(trades, "BTCUSDT", now) is True

def test_revenge_not_detected_when_no_recent_loss(now: datetime) -> None:
    trades = [
        TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=60),
            closed_at=now - timedelta(minutes=10),
            realized_pnl=Decimal("100"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ),
        TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=5),
            closed_at=datetime.max,
            realized_pnl=Decimal("0"),
            notional_size=Decimal("2000"),
            risk_percent=Decimal("2"),
            side="LONG"
        )
    ]
    assert detect_revenge(trades, "BTCUSDT", now) is False

def test_revenge_not_detected_when_smaller_reentry(now: datetime) -> None:
    trades = [
        TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=60),
            closed_at=now - timedelta(minutes=10),
            realized_pnl=Decimal("-100"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ),
        TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=5),
            closed_at=datetime.max,
            realized_pnl=Decimal("0"),
            notional_size=Decimal("500"),
            risk_percent=Decimal("2"),
            side="LONG"
        )
    ]
    assert detect_revenge(trades, "BTCUSDT", now) is False

def test_revenge_not_detected_when_outside_window(now: datetime) -> None:
    trades = [
        TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=120),
            closed_at=now - timedelta(minutes=60),
            realized_pnl=Decimal("-100"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ),
        TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=5),
            closed_at=datetime.max,
            realized_pnl=Decimal("0"),
            notional_size=Decimal("2000"),
            risk_percent=Decimal("2"),
            side="LONG"
        )
    ]
    assert detect_revenge(trades, "BTCUSDT", now) is False

def test_overtrading_detected_at_2x_baseline(now: datetime) -> None:
    trades = []
    for i in range(1, 31):
        trades.append(TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(days=i, hours=1),
            closed_at=now - timedelta(days=i),
            realized_pnl=Decimal("0"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ))
    for i in range(5):
        trades.append(TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(hours=2+i),
            closed_at=now - timedelta(hours=1+i),
            realized_pnl=Decimal("0"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ))
    assert detect_overtrading(trades, now) is True

def test_overtrading_not_detected_below_baseline(now: datetime) -> None:
    trades = []
    for i in range(1, 31):
        trades.append(TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(days=i, hours=1),
            closed_at=now - timedelta(days=i),
            realized_pnl=Decimal("0"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ))
    trades.append(TradeRecord(
        symbol="BTCUSDT",
        opened_at=now - timedelta(hours=2),
        closed_at=now - timedelta(hours=1),
        realized_pnl=Decimal("0"),
        notional_size=Decimal("1000"),
        risk_percent=Decimal("1"),
        side="LONG"
    ))
    assert detect_overtrading(trades, now) is False

def test_overtrading_skipped_below_min_trades(now: datetime) -> None:
    trades = []
    for i in range(4):
        trades.append(TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(hours=2+i),
            closed_at=now - timedelta(hours=1+i),
            realized_pnl=Decimal("0"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ))
    assert detect_overtrading(trades, now) is False

def test_tilt_detected_monotonic_escalation(now: datetime) -> None:
    trades = []
    for i in range(5):
        trades.append(TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(hours=5-i),
            closed_at=now - timedelta(hours=5-i, minutes=30),
            realized_pnl=Decimal("0"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal(str(1 + i*0.5)),
            side="LONG"
        ))
    assert detect_tilt(trades) is True

def test_tilt_detected_by_threshold(now: datetime) -> None:
    trades = []
    risks = [1.0, 1.0, 1.0, 1.0, 2.0]
    for i, r in enumerate(risks):
        trades.append(TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(hours=5-i),
            closed_at=now - timedelta(hours=5-i, minutes=30),
            realized_pnl=Decimal("0"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal(str(r)),
            side="LONG"
        ))
    assert detect_tilt(trades) is True

def test_tilt_not_detected_flat_risk(now: datetime) -> None:
    trades = []
    for i in range(5):
        trades.append(TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(hours=5-i),
            closed_at=now - timedelta(hours=5-i, minutes=30),
            realized_pnl=Decimal("0"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1.0"),
            side="LONG"
        ))
    assert detect_tilt(trades) is False

def test_evaluate_behavior_flags_combines_detectors(now: datetime) -> None:
    trades = []
    for i in range(1, 31):
        trades.append(TradeRecord(
            symbol="ETHUSDT",
            opened_at=now - timedelta(days=i, hours=1),
            closed_at=now - timedelta(days=i),
            realized_pnl=Decimal("0"),
            notional_size=Decimal("1000"),
            risk_percent=Decimal("1"),
            side="LONG"
        ))
    risks = [1.0, 1.0, 1.0, 1.0, 2.0]
    for i, r in enumerate(risks):
        pnl = Decimal("-100") if i == 3 else Decimal("0")
        trades.append(TradeRecord(
            symbol="BTCUSDT",
            opened_at=now - timedelta(minutes=60 - i*10),
            closed_at=now - timedelta(minutes=55 - i*10),
            realized_pnl=pnl,
            notional_size=Decimal(str(1000 * r)),
            risk_percent=Decimal(str(r)),
            side="LONG"
        ))
    flags = evaluate_behavior_flags(trades, "BTCUSDT", now)
    assert flags == frozenset({"revenge", "overtrading", "tilt"})

@dataclass
class DummyConstitution:
    risk_per_trade_percent: float
    daily_loss_limit_percent: float
    weekly_loss_limit_percent: float
    max_leverage: int
    max_concurrent_positions: int
    max_correlated_exposure_percent: float
    min_risk_reward: float
    allowed_sessions: list[str]
    allowed_symbols: list[str]
    binding_cooldowns: dict[str, bool]

def test_binding_vs_advisory_in_risk_engine(now: datetime) -> None:
    proposal = TradeProposal(
        symbol="BTCUSDT",
        side=Side.LONG,
        entry_price=Decimal("100"),
        stop_price=Decimal("90"),
        take_profit_price=Decimal("120"),
        leverage=Decimal("1"),
        proposed_notional_percent=Decimal("1"),
        correlation_bucket="crypto",
        risk_percent=Decimal("1.0")
    )

    account_state = AccountState(
        balance=Decimal("1000"),
        open_position_count=0,
        daily_realized_pnl_percent=Decimal("0"),
        weekly_realized_pnl_percent=Decimal("0"),
        active_behavior_flags=frozenset({"revenge"})
    )

    const_binding = DummyConstitution(
        risk_per_trade_percent=1.0,
        daily_loss_limit_percent=5.0,
        weekly_loss_limit_percent=10.0,
        max_leverage=10,
        max_concurrent_positions=5,
        max_correlated_exposure_percent=100.0,
        min_risk_reward=1.0,
        allowed_sessions=[],
        allowed_symbols=[],
        binding_cooldowns={"revenge": True}
    )

    decision = evaluate_permit(proposal, account_state, const_binding, now=now, session="new_york")
    assert decision.status.value == "REJECTED"
    assert any(r.value == "BINDING_COOLDOWN_ACTIVE" for r in decision.reasons)

    const_advisory = DummyConstitution(
        risk_per_trade_percent=1.0,
        daily_loss_limit_percent=5.0,
        weekly_loss_limit_percent=10.0,
        max_leverage=10,
        max_concurrent_positions=5,
        max_correlated_exposure_percent=100.0,
        min_risk_reward=1.0,
        allowed_sessions=[],
        allowed_symbols=[],
        binding_cooldowns={"revenge": False}
    )

    decision_advisory = evaluate_permit(
        proposal, account_state, const_advisory, now=now, session="new_york"
    )
    assert decision_advisory.status.value == "APPROVED"
