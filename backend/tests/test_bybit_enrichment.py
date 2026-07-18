"""Unit tests for the pure Bybit order-history enrichment functions.

No DB, no network — pure dict-in/dataclass-out.
"""

from app.bybit.constants import (
    CLOSE_TRIGGER_LIQUIDATION,
    CLOSE_TRIGGER_MANUAL_LIMIT,
    CLOSE_TRIGGER_MANUAL_MARKET,
    CLOSE_TRIGGER_SL_HIT,
    CLOSE_TRIGGER_TP_HIT,
    OPEN_TIME_SOURCE_ESTIMATED,
    OPEN_TIME_SOURCE_ORDER_HISTORY,
)
from app.bybit.enrichment import (
    classify_and_enrich,
    find_stop_order,
    find_take_profit_order,
    parse_leverage,
    resolve_real_open_time,
)

BASE_MS = 1_700_000_000_000


def order(**kwargs: object) -> dict[str, object]:
    defaults: dict[str, object] = {
        "orderId": "o1",
        "symbol": "BTCUSDT",
        "side": "Buy",
        "orderType": "Market",
        "stopOrderType": "",
        "orderStatus": "Filled",
        "reduceOnly": False,
        "triggerPrice": "",
        "qty": "1",
        "cumExecQty": "1",
        "createTime": str(BASE_MS),
        "updatedTime": str(BASE_MS),
    }
    defaults.update(kwargs)
    return defaults


# ---------------------------------------------------------------------------
# parse_leverage
# ---------------------------------------------------------------------------


def test_parse_leverage_guards_zero_and_none() -> None:
    assert parse_leverage(None) == 1.0
    assert parse_leverage("") == 1.0
    assert parse_leverage("0") == 1.0
    assert parse_leverage(0) == 1.0
    assert parse_leverage("10") == 10.0
    assert parse_leverage("bogus") == 1.0


# ---------------------------------------------------------------------------
# SL / TP extraction
# ---------------------------------------------------------------------------


def test_find_stop_order_and_take_profit_order() -> None:
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 10_000

    orders = [
        order(
            orderId="sl1",
            stopOrderType="StopLoss",
            triggerPrice="99.5",
            createTime=str(opened_ms + 1000),
            orderStatus="Filled",
        ),
        order(
            orderId="tp1",
            stopOrderType="TakeProfit",
            triggerPrice="101.5",
            createTime=str(opened_ms + 2000),
            orderStatus="New",
        ),
        order(orderId="unrelated", createTime=str(opened_ms + 3000)),
    ]

    sl = find_stop_order(orders, opened_ms, closed_ms)
    tp = find_take_profit_order(orders, opened_ms, closed_ms)
    assert sl is not None and sl["orderId"] == "sl1"
    assert tp is not None and tp["orderId"] == "tp1"


def test_find_stop_order_excludes_outside_window() -> None:
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 10_000
    orders = [
        order(
            orderId="too_early",
            stopOrderType="StopLoss",
            triggerPrice="99.5",
            createTime=str(opened_ms - 5000),
        ),
        order(
            orderId="too_late",
            stopOrderType="StopLoss",
            triggerPrice="99.5",
            createTime=str(closed_ms + 5000),
        ),
    ]
    assert find_stop_order(orders, opened_ms, closed_ms) is None


def test_find_stop_order_picks_earliest_among_multiple() -> None:
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 100_000
    orders = [
        order(
            orderId="later_sl",
            stopOrderType="StopLoss",
            triggerPrice="98.0",
            createTime=str(opened_ms + 5000),
        ),
        order(
            orderId="earlier_sl",
            stopOrderType="StopLoss",
            triggerPrice="99.0",
            createTime=str(opened_ms + 1000),
        ),
    ]
    sl = find_stop_order(orders, opened_ms, closed_ms)
    assert sl is not None and sl["orderId"] == "earlier_sl"


# ---------------------------------------------------------------------------
# close_trigger classification — all 5 cases
# ---------------------------------------------------------------------------


def test_close_trigger_liquidation() -> None:
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 60_000
    orders = [
        order(
            orderId="bust",
            orderType="Market",
            rejectReason="BustTrade",
            updatedTime=str(closed_ms),
            createTime=str(closed_ms),
        ),
    ]
    result = classify_and_enrich(orders, opened_ms, closed_ms, exit_price=100.0)
    assert result.close_trigger == CLOSE_TRIGGER_LIQUIDATION


def test_close_trigger_sl_hit_computes_slippage() -> None:
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 60_000
    orders = [
        order(
            orderId="sl1",
            stopOrderType="StopLoss",
            triggerPrice="99.0",
            orderStatus="Filled",
            createTime=str(opened_ms + 1000),
            updatedTime=str(closed_ms),
        ),
    ]
    result = classify_and_enrich(orders, opened_ms, closed_ms, exit_price=98.5)
    assert result.close_trigger == CLOSE_TRIGGER_SL_HIT
    assert result.stop_loss == 99.0
    assert result.sl_slippage == 98.5 - 99.0


def test_close_trigger_tp_hit_computes_slippage() -> None:
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 60_000
    orders = [
        order(
            orderId="tp1",
            stopOrderType="TakeProfit",
            triggerPrice="105.0",
            orderStatus="Filled",
            createTime=str(opened_ms + 1000),
            updatedTime=str(closed_ms),
        ),
    ]
    result = classify_and_enrich(orders, opened_ms, closed_ms, exit_price=105.4)
    assert result.close_trigger == CLOSE_TRIGGER_TP_HIT
    assert result.take_profit == 105.0
    assert result.tp_slippage == 105.4 - 105.0


def test_close_trigger_manual_limit() -> None:
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 60_000
    orders = [
        order(
            orderId="close1",
            orderType="Limit",
            orderStatus="Filled",
            updatedTime=str(closed_ms),
            createTime=str(closed_ms),
        ),
    ]
    result = classify_and_enrich(orders, opened_ms, closed_ms, exit_price=100.0)
    assert result.close_trigger == CLOSE_TRIGGER_MANUAL_LIMIT


def test_close_trigger_manual_market_default() -> None:
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 60_000
    orders = [
        order(
            orderId="close1",
            orderType="Market",
            orderStatus="Filled",
            updatedTime=str(closed_ms),
            createTime=str(closed_ms),
        ),
    ]
    result = classify_and_enrich(orders, opened_ms, closed_ms, exit_price=100.0)
    assert result.close_trigger == CLOSE_TRIGGER_MANUAL_MARKET


def test_close_trigger_manual_market_with_no_matching_close_order() -> None:
    # No order lands close enough to `closed_ms` to be treated as the close.
    opened_ms = BASE_MS
    closed_ms = BASE_MS + 60_000
    orders = [
        order(orderId="far_away", updatedTime=str(closed_ms + 10_000_000)),
    ]
    result = classify_and_enrich(orders, opened_ms, closed_ms, exit_price=100.0)
    assert result.close_trigger == CLOSE_TRIGGER_MANUAL_MARKET


# ---------------------------------------------------------------------------
# Real open-time reconstruction
# ---------------------------------------------------------------------------


def test_resolve_real_open_time_single_fill() -> None:
    close_ms = BASE_MS + 100_000
    orders = [
        order(
            orderId="entry1",
            side="Buy",
            reduceOnly=False,
            orderStatus="Filled",
            cumExecQty="1.0",
            createTime=str(BASE_MS),
            updatedTime=str(BASE_MS + 500),
        ),
    ]
    # Closing side "Sell" means the position was opened with "Buy".
    result = resolve_real_open_time(orders, closing_side="Sell", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_ORDER_HISTORY
    assert result.opened_at_ms == BASE_MS


def test_resolve_real_open_time_accumulates_across_partial_fills() -> None:
    close_ms = BASE_MS + 100_000
    # Two partial entry fills, newest first by updatedTime, that together
    # cover the closed size. The earliest createTime among the accumulated
    # set should win.
    orders = [
        order(
            orderId="fill_newest",
            side="Buy",
            reduceOnly=False,
            orderStatus="Filled",
            cumExecQty="0.6",
            createTime=str(BASE_MS + 20_000),
            updatedTime=str(BASE_MS + 20_500),
        ),
        order(
            orderId="fill_oldest",
            side="Buy",
            reduceOnly=False,
            orderStatus="Filled",
            cumExecQty="0.6",
            createTime=str(BASE_MS),
            updatedTime=str(BASE_MS + 500),
        ),
    ]
    result = resolve_real_open_time(orders, closing_side="Sell", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_ORDER_HISTORY
    # Walking newest -> oldest: 0.6 (not enough) then +0.6 = 1.2 >= 1.0,
    # earliest createTime among the two accumulated fills is BASE_MS.
    assert result.opened_at_ms == BASE_MS


def test_resolve_real_open_time_ignores_reduce_only_and_wrong_side() -> None:
    close_ms = BASE_MS + 100_000
    orders = [
        order(
            orderId="reduce_only_entry_side",
            side="Buy",
            reduceOnly=True,  # excluded: this is a closing/reducing order
            orderStatus="Filled",
            cumExecQty="1.0",
            createTime=str(BASE_MS),
            updatedTime=str(BASE_MS + 500),
        ),
        order(
            orderId="wrong_side",
            side="Sell",  # excluded: matches closing side, not entry side
            reduceOnly=False,
            orderStatus="Filled",
            cumExecQty="1.0",
            createTime=str(BASE_MS),
            updatedTime=str(BASE_MS + 500),
        ),
    ]
    result = resolve_real_open_time(orders, closing_side="Sell", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_ESTIMATED


def test_resolve_real_open_time_estimated_fallback_when_unmet() -> None:
    close_ms = BASE_MS + 100_000
    orders = [
        order(
            orderId="partial",
            side="Buy",
            reduceOnly=False,
            orderStatus="Filled",
            cumExecQty="0.3",  # never reaches closed_size=1.0
            createTime=str(BASE_MS),
            updatedTime=str(BASE_MS + 500),
        ),
    ]
    result = resolve_real_open_time(orders, closing_side="Sell", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_ESTIMATED
    assert result.opened_at_ms == close_ms - 5 * 60 * 1000


def test_resolve_real_open_time_no_orders_estimated_fallback() -> None:
    close_ms = BASE_MS + 100_000
    result = resolve_real_open_time([], closing_side="Sell", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_ESTIMATED
    assert result.opened_at_ms == close_ms - 5 * 60 * 1000
