"""Pure functions that derive enrichment fields from Binance USDT-M futures
read-only history (`/fapi/v1/userTrades`, `/fapi/v1/allOrders`) for a single
symbol, given one realized-PnL income event.

No DB access and no network I/O here — `service.py` fetches the trades/orders
page(s) and calls into this module with plain dicts/floats so the logic stays
independently unit-testable. Mirrors the shape of the (now-inert)
removed `app.bybit.enrichment` module this replaced, but adapted to Binance's
`/fapi/v1/*` field names — notably, Binance user-trade fills carry the
originating `orderId` directly, so matching the order that produced a closing
fill is an exact lookup here rather than Bybit's nearest-by-time heuristic.
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
    OPEN_TIME_SOURCE_USER_TRADES,
)

UserTrade = dict[str, Any]
Order = dict[str, Any]

# Binance order `type` (or `origType`) values that indicate a protective exit.
STOP_ORDER_TYPES = {"STOP", "STOP_MARKET"}
TAKE_PROFIT_ORDER_TYPES = {"TAKE_PROFIT", "TAKE_PROFIT_MARKET"}
LIQUIDATION_ORDER_TYPES = {"LIQUIDATION"}


@dataclass(frozen=True)
class OpenTimeResult:
    opened_at_ms: int
    source: str  # "user_trades" | "estimated"
    weighted_entry_price: float | None = None


@dataclass(frozen=True)
class EnrichmentResult:
    stop_loss: float | None
    take_profit: float | None
    close_trigger: str | None
    sl_slippage: float | None
    tp_slippage: float | None


def parse_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def is_opening_fill(trade: UserTrade) -> bool:
    """Binance user-trade fills that increase/open a position always report
    `realizedPnl == 0`; fills that reduce/close a position report the
    realized PnL for the portion closed. Used as the entry-vs-exit heuristic
    since `/fapi/v1/userTrades` (unlike `/fapi/v1/allOrders`) carries no
    explicit `reduceOnly` flag."""
    return (parse_float(trade.get("realizedPnl")) or 0.0) == 0.0


def resolve_real_open_time(
    trades: list[UserTrade],
    closing_side: str,
    closed_size: float,
    close_ms: int,
) -> OpenTimeResult:
    """Reconstruct the real position-open time (and weighted-avg entry price)
    from `/fapi/v1/userTrades` fills.

    Walks opening fills (`realizedPnl == 0`) on the entry side (opposite of
    the closing side) newest-to-oldest, accumulating executed quantity until
    it covers the closed size. Falls back to a fixed estimate — and no entry
    price — if the fills on record don't add up (partial history window,
    older/expired trades, etc).
    """
    entry_side = "BUY" if closing_side == "SELL" else "SELL"

    candidates = [
        t
        for t in trades
        if t.get("side") == entry_side
        and is_opening_fill(t)
        and parse_float(t.get("time")) is not None
        and int(t["time"]) < close_ms
    ]
    candidates.sort(key=lambda t: int(t["time"]), reverse=True)

    accumulated_qty = 0.0
    accumulated_notional = 0.0
    earliest_time: int | None = None
    for trade in candidates:
        qty = parse_float(trade.get("qty")) or 0.0
        price = parse_float(trade.get("price")) or 0.0
        accumulated_qty += qty
        accumulated_notional += qty * price
        t_time = int(trade["time"])
        if earliest_time is None or t_time < earliest_time:
            earliest_time = t_time
        if accumulated_qty >= closed_size:
            if earliest_time is not None:
                weighted_price = (
                    accumulated_notional / accumulated_qty if accumulated_qty > 0 else None
                )
                return OpenTimeResult(earliest_time, OPEN_TIME_SOURCE_USER_TRADES, weighted_price)
            break

    return OpenTimeResult(close_ms - ESTIMATED_OPEN_OFFSET_MS, OPEN_TIME_SOURCE_ESTIMATED, None)


def find_order_by_id(orders: list[Order], order_id: Any) -> Order | None:
    if order_id is None:
        return None
    for o in orders:
        if str(o.get("orderId")) == str(order_id):
            return o
    return None


def classify_and_enrich(closing_order: Order | None, exit_price: float) -> EnrichmentResult:
    """Classify how a position was closed from the Binance order that
    generated the closing fill."""
    if closing_order is None:
        return EnrichmentResult(None, None, CLOSE_TRIGGER_MANUAL_MARKET, None, None)

    order_type = str(closing_order.get("type") or closing_order.get("origType") or "")
    stop_price = parse_float(closing_order.get("stopPrice"))

    if order_type in LIQUIDATION_ORDER_TYPES:
        return EnrichmentResult(None, None, CLOSE_TRIGGER_LIQUIDATION, None, None)

    if order_type in STOP_ORDER_TYPES:
        slippage = (exit_price - stop_price) if stop_price is not None else None
        return EnrichmentResult(stop_price, None, CLOSE_TRIGGER_SL_HIT, slippage, None)

    if order_type in TAKE_PROFIT_ORDER_TYPES:
        slippage = (exit_price - stop_price) if stop_price is not None else None
        return EnrichmentResult(None, stop_price, CLOSE_TRIGGER_TP_HIT, None, slippage)

    if order_type == "LIMIT":
        return EnrichmentResult(None, None, CLOSE_TRIGGER_MANUAL_LIMIT, None, None)

    return EnrichmentResult(None, None, CLOSE_TRIGGER_MANUAL_MARKET, None, None)
