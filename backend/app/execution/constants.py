from enum import StrEnum


class ErrorCode(StrEnum):
    CONSTITUTION_NOT_FOUND = "CONSTITUTION_NOT_FOUND"
    CONSTITUTION_INVALID = "CONSTITUTION_INVALID"
    PERMIT_NOT_FOUND = "PERMIT_NOT_FOUND"


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
