from decimal import Decimal
from enum import StrEnum


class ErrorCode(StrEnum):
    CONSTITUTION_NOT_FOUND = "CONSTITUTION_NOT_FOUND"
    CONSTITUTION_INVALID = "CONSTITUTION_INVALID"
    PERMIT_NOT_FOUND = "PERMIT_NOT_FOUND"
    PERMIT_EXPIRED = "PERMIT_EXPIRED"
    PERMIT_ALREADY_USED = "PERMIT_ALREADY_USED"
    PERMIT_REJECTED = "PERMIT_REJECTED"
    PERMIT_MISMATCH = "PERMIT_MISMATCH"
    ENTRY_DRIFT = "ENTRY_DRIFT"
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

# ---------------------------------------------------------------------------
# Execution-plane correctness constants (TRADE-FLOW-2026-07-23 §1/§2).
# ---------------------------------------------------------------------------

# F1 — margin mode the exchange must be set to before entry. Isolated is the
# beginner-correct default (contained blast radius); CROSSED is opt-in.
MARGIN_TYPE_ISOLATED = "ISOLATED"
MARGIN_TYPE_CROSSED = "CROSSED"
DEFAULT_MARGIN_TYPE = MARGIN_TYPE_CROSSED
VALID_MARGIN_TYPES = frozenset({MARGIN_TYPE_ISOLATED, MARGIN_TYPE_CROSSED})

# Binance returns this error code from POST /fapi/v1/marginType when the
# symbol is already in the requested mode — a no-op success, not a failure.
BINANCE_NO_NEED_TO_CHANGE_MARGIN_TYPE = -4046

# Terminal execution status stamped when leverage/margin could not be
# synced+confirmed before entry (F1). Entry is aborted rather than submitted
# against an unconfirmed leverage/mode.
LEVERAGE_SYNC_FAILED = "LEVERAGE_SYNC_FAILED"

# F2 — liquidation must sit at least this fraction of the stop distance
# BEYOND the stop (in the adverse direction). Below this buffer the exchange
# could liquidate before the stop ever fires, voiding the mandatory-stop
# invariant. 0.20 = liquidation must be ≥ 20% of stop distance past the stop.
LIQ_STOP_BUFFER = Decimal("0.20")

# Flat maintenance-margin rate for the isolated liquidation estimate. Kept
# flat (no tiered exchangeInfo brackets) this pass — see sizing.py docstring.
# Single source of truth shared by sizing.py and the risk-engine max-leverage
# hint so both agree on the estimate.
DEFAULT_MAINTENANCE_MARGIN_RATE = Decimal("0.005")

# F4 — entry-drift consume-time guard. At consume, if the current mark price
# has drifted from the proposal entry by more than this fraction of the stop
# distance, the market entry is rejected (ENTRY_DRIFT) rather than filled far
# from the price the permit's risk numbers were judged at. Market entries
# only; limit entries are bounded by their limit price.
ENTRY_DRIFT_MAX_FRACTION_OF_STOP = 0.25

# D1 — the stop-loss leg gets a tighter timeout than the 10s entry timeout,
# with exactly one immediate retry before the flatten path triggers. Shrinks
# the worst-case unprotected window without adding risk.
SL_ORDER_TIMEOUT_SECONDS = 3.0
SL_TIMEOUT_RETRIES = 1
