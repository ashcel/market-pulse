from enum import StrEnum


class ErrorCode(StrEnum):
    CONSTITUTION_NOT_FOUND = "CONSTITUTION_NOT_FOUND"
    CONSTITUTION_INVALID = "CONSTITUTION_INVALID"
    PERMIT_NOT_FOUND = "PERMIT_NOT_FOUND"
    PERMIT_EXPIRED = "PERMIT_EXPIRED"
    PERMIT_ALREADY_USED = "PERMIT_ALREADY_USED"
    PERMIT_REJECTED = "PERMIT_REJECTED"
    PERMIT_MISMATCH = "PERMIT_MISMATCH"
    EXECUTION_DISABLED = "EXECUTION_DISABLED"
    EXECUTION_NOT_READY = "EXECUTION_NOT_READY"
    DUPLICATE_IDEMPOTENCY_KEY = "DUPLICATE_IDEMPOTENCY_KEY"
    EXECUTION_IN_PROGRESS = "EXECUTION_IN_PROGRESS"


# Sessions the constitution's `allowed_sessions` may name. Mirrors the
# session buckets already used by the review analytics (asia/london/new_york).
VALID_SESSIONS = frozenset({"asia", "london", "new_york"})

# Behavior detectors M9-T11 will implement. A constitution may opt any of
# these into `binding_cooldowns` (True = binding rejection, False/absent =
# advisory-only). Listed here (not in validation.py) so the risk-engine and
# behavior-detector work in later tasks share one source of truth.
KNOWN_BEHAVIOR_DETECTORS = frozenset({"revenge", "overtrading", "tilt"})

RISK_PER_TRADE_MIN_PERCENT = 0.5
RISK_PER_TRADE_MAX_PERCENT = 3.0
MAX_CORRELATED_EXPOSURE_MAX_PERCENT = 100.0

# M9-T5 Trade Permit TTL (EDR 0020 decision 6: "Permits carry a short TTL —
# market state moves; a stale permit cannot be executed"). Seconds from
# `PermitDecision.evaluated_at` to expiry.
PERMIT_TTL_SECONDS = 90

# Behavior detector tuning constants
REVENGE_WINDOW_MINUTES = 30
OVERTRADING_WINDOW_HOURS = 24
OVERTRADING_LOOKBACK_DAYS = 30
OVERTRADING_BASELINE_MULTIPLIER = 2.0
OVERTRADING_MIN_TRADES = 5
TILT_WINDOW_TRADES = 5
TILT_RISK_THRESHOLD_MULTIPLIER = 1.5

EXEC_KEY_NOT_FOUND = "EXEC_KEY_NOT_FOUND"
EXEC_KEY_WITHDRAWAL_SCOPE = "EXEC_KEY_WITHDRAWAL_SCOPE"
EXEC_KEY_IP_NOT_ALLOWLISTED = "EXEC_KEY_IP_NOT_ALLOWLISTED"
EXEC_KEY_CREDENTIALS_INVALID = "EXEC_KEY_CREDENTIALS_INVALID"
EXECUTION_DISABLED = "EXECUTION_DISABLED"
EXECUTION_NOT_READY = "EXECUTION_NOT_READY"
DUPLICATE_IDEMPOTENCY_KEY = "DUPLICATE_IDEMPOTENCY_KEY"
EXECUTION_IN_PROGRESS = "EXECUTION_IN_PROGRESS"
TRADE_LOCK_VIOLATION = "TRADE_LOCK_VIOLATION"

STOP_WIDEN_TOLERANCE = 1.1

EXECUTION_ENABLED = False
