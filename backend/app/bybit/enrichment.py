"""Pure functions that derive enrichment fields from Bybit `/v5/order/history`
rows for a single symbol, given one closed-PnL trade.

No DB access and no network I/O here — `service.py` fetches the order-history
page(s) and calls into this module with plain dicts/floats so the logic stays
independently unit-testable.
"""

from dataclasses import dataclass
from typing import Any

from .constants import (
    CLOSE_TRIGGER_LIQUIDATION,
    CLOSE_TRIGGER_MANUAL_LIMIT,
    CLOSE_TRIGGER_MANUAL_MARKET,
    CLOSE_TRIGGER_SL_HIT,
    CLOSE_TRIGGER_TP_HIT,
    ESTIMATED_OPEN_OFFSET_MS,
    OPEN_TIME_SOURCE_ESTIMATED,
    OPEN_TIME_SOURCE_ORDER_HISTORY,
)

# Window used to match the order that actually closed the position: the
# nearest-by-time order to the closed-PnL row's close timestamp. Bybit's
# closing fill and the closed-PnL settlement record land within seconds of
# each other in practice; a minute of slack absorbs normal reporting lag
# without pulling in unrelated later orders.
CLOSE_ORDER_MATCH_TOLERANCE_MS = 60_000

Order = dict[str, Any]


@dataclass(frozen=True)
class OpenTimeResult:
    opened_at_ms: int
    source: str  # "order_history" | "estimated"


@dataclass(frozen=True)
class EnrichmentResult:
    stop_loss: float | None
    take_profit: float | None
    close_trigger: str | None
    sl_slippage: float | None
    tp_slippage: float | None


def parse_leverage(raw: Any) -> float:
    """Guard against Bybit returning `""`, `None`, or `"0"` for leverage."""
    try:
        value = float(raw or 0)
    except (TypeError, ValueError):
        value = 0.0
    return value or 1.0


def _parse_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _updated_time_ms(order: Order) -> int | None:
    return _parse_int(order.get("updatedTime"))


def _create_time_ms(order: Order) -> int | None:
    return _parse_int(order.get("createTime"))


def _parse_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def resolve_real_open_time(
    orders: list[Order],
    closing_side: str,
    closed_size: float,
    close_ms: int,
) -> OpenTimeResult:
    """Reconstruct the real position-open time from order-history fills.

    Walks Filled, non-reduce-only orders on the entry side (opposite of the
    closing side) newest-to-oldest, accumulating executed quantity until it
    covers the closed size. Falls back to a fixed estimate if the fills on
    record don't add up (partial history window, older/expired orders, etc).
    """
    entry_side = "Buy" if closing_side == "Sell" else "Sell"

    candidates = [
        o
        for o in orders
        if o.get("orderStatus") == "Filled"
        and not o.get("reduceOnly", False)
        and o.get("side") == entry_side
        and (_updated_time_ms(o) is not None)
        and _updated_time_ms(o) < close_ms  # type: ignore[operator]
        and _create_time_ms(o) is not None
    ]
    candidates.sort(key=lambda o: _updated_time_ms(o) or 0, reverse=True)

    accumulated = 0.0
    earliest_create_time: int | None = None
    for order in candidates:
        qty = _parse_float(order.get("cumExecQty")) or _parse_float(order.get("qty")) or 0.0
        accumulated += qty
        create_time = _create_time_ms(order)
        if create_time is not None and (
            earliest_create_time is None or create_time < earliest_create_time
        ):
            earliest_create_time = create_time
        if accumulated >= closed_size:
            if earliest_create_time is not None:
                return OpenTimeResult(earliest_create_time, OPEN_TIME_SOURCE_ORDER_HISTORY)
            break

    return OpenTimeResult(close_ms - ESTIMATED_OPEN_OFFSET_MS, OPEN_TIME_SOURCE_ESTIMATED)


def _in_window(order: Order, start_ms: int, end_ms: int) -> bool:
    create_time = _create_time_ms(order)
    return create_time is not None and start_ms <= create_time <= end_ms


def find_stop_order(orders: list[Order], opened_ms: int, closed_ms: int) -> Order | None:
    candidates = [
        o
        for o in orders
        if o.get("stopOrderType") == "StopLoss" and _in_window(o, opened_ms, closed_ms)
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda o: _create_time_ms(o) or 0)


def find_take_profit_order(orders: list[Order], opened_ms: int, closed_ms: int) -> Order | None:
    candidates = [
        o
        for o in orders
        if o.get("stopOrderType") == "TakeProfit" and _in_window(o, opened_ms, closed_ms)
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda o: _create_time_ms(o) or 0)


def _find_close_order(orders: list[Order], closed_ms: int) -> Order | None:
    best: Order | None = None
    best_distance: int | None = None
    for order in orders:
        updated = _updated_time_ms(order)
        if updated is None:
            continue
        distance = abs(updated - closed_ms)
        if distance > CLOSE_ORDER_MATCH_TOLERANCE_MS:
            continue
        if best_distance is None or distance < best_distance:
            best = order
            best_distance = distance
    return best


def classify_and_enrich(
    orders: list[Order],
    opened_ms: int,
    closed_ms: int,
    exit_price: float,
) -> EnrichmentResult:
    """Extract SL/TP trigger prices and classify how the trade was closed."""
    sl_order = find_stop_order(orders, opened_ms, closed_ms)
    tp_order = find_take_profit_order(orders, opened_ms, closed_ms)
    sl_price = _parse_float(sl_order.get("triggerPrice")) if sl_order else None
    tp_price = _parse_float(tp_order.get("triggerPrice")) if tp_order else None

    close_order = _find_close_order(orders, closed_ms)
    reject_reason = (close_order or {}).get("rejectReason")

    sl_slippage: float | None = None
    tp_slippage: float | None = None
    close_trigger: str | None = None

    sl_fired = sl_order is not None and sl_order.get("orderStatus") == "Filled"
    tp_fired = tp_order is not None and tp_order.get("orderStatus") == "Filled"

    if reject_reason == "BustTrade":
        close_trigger = CLOSE_TRIGGER_LIQUIDATION
    elif sl_fired:
        close_trigger = CLOSE_TRIGGER_SL_HIT
        if sl_price is not None:
            sl_slippage = exit_price - sl_price
    elif tp_fired:
        close_trigger = CLOSE_TRIGGER_TP_HIT
        if tp_price is not None:
            tp_slippage = exit_price - tp_price
    elif (close_order or {}).get("orderType") == "Limit":
        close_trigger = CLOSE_TRIGGER_MANUAL_LIMIT
    else:
        close_trigger = CLOSE_TRIGGER_MANUAL_MARKET

    return EnrichmentResult(
        stop_loss=sl_price,
        take_profit=tp_price,
        close_trigger=close_trigger,
        sl_slippage=sl_slippage,
        tp_slippage=tp_slippage,
    )
