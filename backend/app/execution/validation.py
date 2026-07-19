"""Pure validation of a Trading Constitution payload.

No DB, no I/O, no FastAPI/pydantic imports — this is the unit-testable
core the DoD calls out. `ConstitutionInput` is a structural Protocol so
tests can validate lightweight dataclasses/objects without constructing a
full pydantic model; `service.py` passes the `ConstitutionCreate` schema
straight in since it already satisfies the same shape.
"""

from dataclasses import dataclass
from typing import Protocol

from .constants import (
    KNOWN_BEHAVIOR_DETECTORS,
    MAX_CORRELATED_EXPOSURE_MAX_PERCENT,
    RISK_PER_TRADE_MAX_PERCENT,
    RISK_PER_TRADE_MIN_PERCENT,
    VALID_SESSIONS,
    ErrorCode,
)


class ConstitutionInput(Protocol):
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


@dataclass(frozen=True, slots=True)
class ValidationError:
    field: str
    code: ErrorCode
    message: str


def validate_constitution(payload: ConstitutionInput) -> list[ValidationError]:
    """Enforce every band from EDR 0020 decision 2 / M9-T1. Returns an empty
    list when the payload is valid — callers (service.py) raise on any
    entries, never on partial acceptance.
    """
    errors: list[ValidationError] = []

    risk_in_band = (
        RISK_PER_TRADE_MIN_PERCENT <= payload.risk_per_trade_percent <= RISK_PER_TRADE_MAX_PERCENT
    )
    if not risk_in_band:
        errors.append(
            ValidationError(
                field="risk_per_trade_percent",
                code=ErrorCode.CONSTITUTION_INVALID,
                message=(
                    f"risk_per_trade_percent must be between {RISK_PER_TRADE_MIN_PERCENT} "
                    f"and {RISK_PER_TRADE_MAX_PERCENT} (got {payload.risk_per_trade_percent})"
                ),
            )
        )

    if payload.daily_loss_limit_percent < 0:
        errors.append(
            ValidationError(
                field="daily_loss_limit_percent",
                code=ErrorCode.CONSTITUTION_INVALID,
                message="daily_loss_limit_percent must be >= 0",
            )
        )

    if payload.weekly_loss_limit_percent < 0:
        errors.append(
            ValidationError(
                field="weekly_loss_limit_percent",
                code=ErrorCode.CONSTITUTION_INVALID,
                message="weekly_loss_limit_percent must be >= 0",
            )
        )

    if (
        payload.daily_loss_limit_percent >= 0
        and payload.weekly_loss_limit_percent >= 0
        and payload.weekly_loss_limit_percent < payload.daily_loss_limit_percent
    ):
        errors.append(
            ValidationError(
                field="weekly_loss_limit_percent",
                code=ErrorCode.CONSTITUTION_INVALID,
                message="weekly_loss_limit_percent must be >= daily_loss_limit_percent",
            )
        )

    if payload.max_leverage < 1:
        errors.append(
            ValidationError(
                field="max_leverage",
                code=ErrorCode.CONSTITUTION_INVALID,
                message="max_leverage must be >= 1",
            )
        )

    if payload.max_concurrent_positions < 1:
        errors.append(
            ValidationError(
                field="max_concurrent_positions",
                code=ErrorCode.CONSTITUTION_INVALID,
                message="max_concurrent_positions must be >= 1",
            )
        )

    if not (0 <= payload.max_correlated_exposure_percent <= MAX_CORRELATED_EXPOSURE_MAX_PERCENT):
        errors.append(
            ValidationError(
                field="max_correlated_exposure_percent",
                code=ErrorCode.CONSTITUTION_INVALID,
                message=(
                    f"max_correlated_exposure_percent must be between 0 and "
                    f"{MAX_CORRELATED_EXPOSURE_MAX_PERCENT} "
                    f"(got {payload.max_correlated_exposure_percent})"
                ),
            )
        )

    if payload.min_risk_reward <= 0:
        errors.append(
            ValidationError(
                field="min_risk_reward",
                code=ErrorCode.CONSTITUTION_INVALID,
                message="min_risk_reward must be > 0",
            )
        )

    invalid_sessions = sorted(set(payload.allowed_sessions) - VALID_SESSIONS)
    if invalid_sessions:
        errors.append(
            ValidationError(
                field="allowed_sessions",
                code=ErrorCode.CONSTITUTION_INVALID,
                message=(
                    f"unknown session(s): {', '.join(invalid_sessions)} "
                    f"(valid: {sorted(VALID_SESSIONS)})"
                ),
            )
        )

    if any(not isinstance(sym, str) or not sym.strip() for sym in payload.allowed_symbols):
        errors.append(
            ValidationError(
                field="allowed_symbols",
                code=ErrorCode.CONSTITUTION_INVALID,
                message="allowed_symbols entries must be non-empty strings",
            )
        )

    invalid_detectors = sorted(set(payload.binding_cooldowns.keys()) - KNOWN_BEHAVIOR_DETECTORS)
    if invalid_detectors:
        errors.append(
            ValidationError(
                field="binding_cooldowns",
                code=ErrorCode.CONSTITUTION_INVALID,
                message=(
                    f"unknown behavior detector(s): {', '.join(invalid_detectors)} "
                    f"(valid: {sorted(KNOWN_BEHAVIOR_DETECTORS)})"
                ),
            )
        )

    return errors
