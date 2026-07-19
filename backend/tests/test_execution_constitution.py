"""Unit tests for `validate_constitution` — the pure, unit-testable core of
the Trading Constitution (M9-T1 / EDR 0020 decision 2).

No DB, no I/O, no FastAPI app — a local dataclass satisfies
`ConstitutionInput` structurally. Do NOT add DB/app-client tests to this
file; those belong in a separate router-level test module.
"""

from dataclasses import dataclass, field

from app.execution.constants import ErrorCode
from app.execution.validation import validate_constitution


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


def field_errors(errors: list, field_name: str) -> list:
    return [e for e in errors if e.field == field_name]


# ---------------------------------------------------------------------------
# Valid config accepted
# ---------------------------------------------------------------------------


def test_valid_config_is_accepted() -> None:
    assert validate_constitution(FakeConstitution()) == []


def test_valid_config_with_empty_optional_collections_is_accepted() -> None:
    payload = FakeConstitution(allowed_sessions=[], allowed_symbols=[], binding_cooldowns={})
    assert validate_constitution(payload) == []


def test_valid_config_at_band_edges_is_accepted() -> None:
    payload = FakeConstitution(
        risk_per_trade_percent=0.5,
        max_correlated_exposure_percent=0.0,
        weekly_loss_limit_percent=3.0,
        daily_loss_limit_percent=3.0,
    )
    assert validate_constitution(payload) == []

    payload = FakeConstitution(risk_per_trade_percent=3.0, max_correlated_exposure_percent=100.0)
    assert validate_constitution(payload) == []


# ---------------------------------------------------------------------------
# risk_per_trade_percent — 0.5 to 3.0 band
# ---------------------------------------------------------------------------


def test_risk_per_trade_below_band_rejected() -> None:
    errors = validate_constitution(FakeConstitution(risk_per_trade_percent=0.49))
    assert len(field_errors(errors, "risk_per_trade_percent")) == 1
    assert errors[0].code == ErrorCode.CONSTITUTION_INVALID


def test_risk_per_trade_above_band_rejected() -> None:
    errors = validate_constitution(FakeConstitution(risk_per_trade_percent=3.01))
    assert len(field_errors(errors, "risk_per_trade_percent")) == 1


def test_risk_per_trade_zero_rejected() -> None:
    errors = validate_constitution(FakeConstitution(risk_per_trade_percent=0))
    assert len(field_errors(errors, "risk_per_trade_percent")) == 1


def test_risk_per_trade_negative_rejected() -> None:
    errors = validate_constitution(FakeConstitution(risk_per_trade_percent=-1))
    assert len(field_errors(errors, "risk_per_trade_percent")) == 1


# ---------------------------------------------------------------------------
# Loss limits — daily/weekly >= 0, weekly >= daily
# ---------------------------------------------------------------------------


def test_negative_daily_loss_limit_rejected() -> None:
    errors = validate_constitution(FakeConstitution(daily_loss_limit_percent=-0.01))
    assert len(field_errors(errors, "daily_loss_limit_percent")) == 1


def test_negative_weekly_loss_limit_rejected() -> None:
    errors = validate_constitution(FakeConstitution(weekly_loss_limit_percent=-0.01))
    assert len(field_errors(errors, "weekly_loss_limit_percent")) == 1


def test_zero_loss_limits_accepted() -> None:
    payload = FakeConstitution(daily_loss_limit_percent=0, weekly_loss_limit_percent=0)
    assert validate_constitution(payload) == []


def test_weekly_below_daily_rejected() -> None:
    payload = FakeConstitution(daily_loss_limit_percent=5.0, weekly_loss_limit_percent=4.0)
    errors = validate_constitution(payload)
    assert len(field_errors(errors, "weekly_loss_limit_percent")) == 1


def test_weekly_equal_daily_accepted() -> None:
    payload = FakeConstitution(daily_loss_limit_percent=5.0, weekly_loss_limit_percent=5.0)
    assert validate_constitution(payload) == []


# ---------------------------------------------------------------------------
# max_leverage / max_concurrent_positions — >= 1
# ---------------------------------------------------------------------------


def test_max_leverage_below_one_rejected() -> None:
    errors = validate_constitution(FakeConstitution(max_leverage=0))
    assert len(field_errors(errors, "max_leverage")) == 1


def test_max_leverage_negative_rejected() -> None:
    errors = validate_constitution(FakeConstitution(max_leverage=-5))
    assert len(field_errors(errors, "max_leverage")) == 1


def test_max_leverage_one_accepted() -> None:
    assert validate_constitution(FakeConstitution(max_leverage=1)) == []


def test_max_concurrent_positions_below_one_rejected() -> None:
    errors = validate_constitution(FakeConstitution(max_concurrent_positions=0))
    assert len(field_errors(errors, "max_concurrent_positions")) == 1


def test_max_concurrent_positions_one_accepted() -> None:
    assert validate_constitution(FakeConstitution(max_concurrent_positions=1)) == []


# ---------------------------------------------------------------------------
# max_correlated_exposure_percent — 0 to 100 band
# ---------------------------------------------------------------------------


def test_max_correlated_exposure_below_zero_rejected() -> None:
    errors = validate_constitution(FakeConstitution(max_correlated_exposure_percent=-1))
    assert len(field_errors(errors, "max_correlated_exposure_percent")) == 1


def test_max_correlated_exposure_above_hundred_rejected() -> None:
    errors = validate_constitution(FakeConstitution(max_correlated_exposure_percent=100.01))
    assert len(field_errors(errors, "max_correlated_exposure_percent")) == 1


# ---------------------------------------------------------------------------
# min_risk_reward — > 0
# ---------------------------------------------------------------------------


def test_min_risk_reward_zero_rejected() -> None:
    errors = validate_constitution(FakeConstitution(min_risk_reward=0))
    assert len(field_errors(errors, "min_risk_reward")) == 1


def test_min_risk_reward_negative_rejected() -> None:
    errors = validate_constitution(FakeConstitution(min_risk_reward=-1.5))
    assert len(field_errors(errors, "min_risk_reward")) == 1


def test_min_risk_reward_small_positive_accepted() -> None:
    assert validate_constitution(FakeConstitution(min_risk_reward=0.01)) == []


# ---------------------------------------------------------------------------
# allowed_sessions — must be a subset of the known sessions
# ---------------------------------------------------------------------------


def test_unknown_session_rejected() -> None:
    errors = validate_constitution(FakeConstitution(allowed_sessions=["overnight"]))
    assert len(field_errors(errors, "allowed_sessions")) == 1


def test_mixed_known_and_unknown_sessions_rejected() -> None:
    errors = validate_constitution(FakeConstitution(allowed_sessions=["asia", "made-up"]))
    assert len(field_errors(errors, "allowed_sessions")) == 1


def test_all_known_sessions_accepted() -> None:
    payload = FakeConstitution(allowed_sessions=["asia", "london", "new_york"])
    assert validate_constitution(payload) == []


# ---------------------------------------------------------------------------
# allowed_symbols — non-empty strings
# ---------------------------------------------------------------------------


def test_blank_symbol_rejected() -> None:
    errors = validate_constitution(FakeConstitution(allowed_symbols=["BTCUSDT", ""]))
    assert len(field_errors(errors, "allowed_symbols")) == 1


def test_whitespace_only_symbol_rejected() -> None:
    errors = validate_constitution(FakeConstitution(allowed_symbols=["   "]))
    assert len(field_errors(errors, "allowed_symbols")) == 1


# ---------------------------------------------------------------------------
# binding_cooldowns — keys must be known behavior detectors
# ---------------------------------------------------------------------------


def test_unknown_behavior_detector_rejected() -> None:
    errors = validate_constitution(FakeConstitution(binding_cooldowns={"fomo": True}))
    assert len(field_errors(errors, "binding_cooldowns")) == 1


def test_known_behavior_detectors_accepted() -> None:
    payload = FakeConstitution(
        binding_cooldowns={"revenge": True, "overtrading": False, "tilt": True}
    )
    assert validate_constitution(payload) == []


def test_empty_binding_cooldowns_accepted() -> None:
    assert validate_constitution(FakeConstitution(binding_cooldowns={})) == []


# ---------------------------------------------------------------------------
# Multiple simultaneous violations
# ---------------------------------------------------------------------------


def test_multiple_violations_all_reported() -> None:
    payload = FakeConstitution(
        risk_per_trade_percent=10.0,
        max_leverage=0,
        min_risk_reward=-1,
        allowed_sessions=["nope"],
        binding_cooldowns={"panic": True},
    )
    errors = validate_constitution(payload)
    fields = {e.field for e in errors}
    assert fields == {
        "risk_per_trade_percent",
        "max_leverage",
        "min_risk_reward",
        "allowed_sessions",
        "binding_cooldowns",
    }
