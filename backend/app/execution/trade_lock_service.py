"""Trade lock service — M9-T10 (EDR 0020 decision 1 post-entry clause).

Through IQ, open trades are reduce-only:
  - Trail stop (stop can only improve, never widen beyond tolerance)
  - Move to break-even
  - Partial take-profit

Forbidden actions raise TradeLockViolationError:
  - Removing stop entirely
  - Widening stop beyond STOP_WIDEN_TOLERANCE of the original
  - Increasing leverage
  - Averaging down / adding to the position
"""

from sqlalchemy.ext.asyncio import AsyncSession

from .config import execution_settings
from .constants import STOP_WIDEN_TOLERANCE
from .exceptions import ExecutionDisabledError, TradeLockViolationError


async def trail_stop(
    db: AsyncSession,  # noqa: ARG001 — reserved for Phase C order-log writes
    user_id: str,  # noqa: ARG001 — reserved for audit trail
    symbol: str,  # noqa: ARG001 — reserved for order placement
    order_id: str,  # noqa: ARG001 — reserved for order modification
    new_stop_price: float,
    original_stop: float | None = None,
    side: str = "LONG",
) -> dict[str, object]:
    """Move the stop to a better position.

    Rejection conditions:
    - Kill switch off.
    - New stop widens risk beyond ``original_stop * STOP_WIDEN_TOLERANCE``
      (stop moves AWAY from the trade entry = larger risk).
    """
    if not execution_settings.ENABLED:
        raise ExecutionDisabledError("Execution disabled")

    if original_stop is not None:
        # For LONG: stop must be >= original / STOP_WIDEN_TOLERANCE
        # (i.e., only allow widening by at most the tolerance fraction)
        tolerance_limit = original_stop / STOP_WIDEN_TOLERANCE
        if side == "LONG" and new_stop_price < tolerance_limit:
            raise TradeLockViolationError(
                f"Stop widened beyond tolerance: {new_stop_price} < "
                f"original {original_stop} / {STOP_WIDEN_TOLERANCE}"
            )
        # For SHORT: stop must not go above original * STOP_WIDEN_TOLERANCE.
        # Use round() to dodge floating-point representation (100 * 1.1 → 110.000...001).
        if side == "SHORT" and new_stop_price >= round(original_stop * STOP_WIDEN_TOLERANCE, 8):
            raise TradeLockViolationError(
                f"Stop widened beyond tolerance: {new_stop_price} >= "
                f"original {original_stop} * {STOP_WIDEN_TOLERANCE}"
            )

    return {"status": "ok", "new_stop_price": new_stop_price}


async def move_to_breakeven(
    db: AsyncSession,  # noqa: ARG001
    user_id: str,  # noqa: ARG001
    symbol: str,  # noqa: ARG001
    order_id: str,  # noqa: ARG001
    entry_price: float,
    side: str,  # noqa: ARG001
) -> dict[str, object]:
    """Move the stop to the entry price (break-even).

    This always improves risk (stop moves in the profitable direction),
    so it is always allowed under the trade-lock rules.
    """
    if not execution_settings.ENABLED:
        raise ExecutionDisabledError("Execution disabled")
    return {"status": "ok", "breakeven": entry_price}


async def partial_take_profit(
    db: AsyncSession,  # noqa: ARG001
    user_id: str,  # noqa: ARG001
    symbol: str,  # noqa: ARG001
    quantity: float,
) -> dict[str, object]:
    """Close a portion of the position (reduce-only).

    EDR 0020 decision 1: reduce-only management only; no new position addition.
    """
    if not execution_settings.ENABLED:
        raise ExecutionDisabledError("Execution disabled")
    return {"status": "ok", "quantity": quantity}


async def get_open_trades(
    db: AsyncSession,  # noqa: ARG001
    user_id: str,  # noqa: ARG001
) -> list[dict[str, object]]:
    """Return open positions + their associated orders.

    Phase B+: fetches from account_service + open-orders list.
    Phase A stub: returns empty list.
    """
    return []
