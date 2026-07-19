"""Unit tests for the pure Binance order/trade enrichment functions.

No DB, no network — pure dict-in/dataclass-out.
"""

from app.binance_review.constants import (
    CLOSE_TRIGGER_LIQUIDATION,
    CLOSE_TRIGGER_MANUAL_LIMIT,
    CLOSE_TRIGGER_MANUAL_MARKET,
    CLOSE_TRIGGER_SL_HIT,
    CLOSE_TRIGGER_TP_HIT,
    OPEN_TIME_SOURCE_ESTIMATED,
    OPEN_TIME_SOURCE_USER_TRADES,
)
from app.binance_review.enrichment import (
    classify_and_enrich,
    find_order_by_id,
    is_opening_fill,
    resolve_real_open_time,
)

BASE_MS = 1_700_000_000_000


def trade(**kwargs: object) -> dict[str, object]:
    defaults: dict[str, object] = {
        "symbol": "BTCUSDT",
        "id": 1,
        "orderId": 100,
        "side": "BUY",
        "price": "100",
        "qty": "1",
        "realizedPnl": "0",
        "commission": "0.01",
        "time": BASE_MS,
    }
    defaults.update(kwargs)
    return defaults


def order(**kwargs: object) -> dict[str, object]:
    defaults: dict[str, object] = {
        "orderId": 100,
        "symbol": "BTCUSDT",
        "type": "MARKET",
        "stopPrice": "0",
        "status": "FILLED",
    }
    defaults.update(kwargs)
    return defaults


# ---------------------------------------------------------------------------
# is_opening_fill
# ---------------------------------------------------------------------------


def test_is_opening_fill_true_when_zero_realized_pnl() -> None:
    assert is_opening_fill(trade(realizedPnl="0")) is True


def test_is_opening_fill_false_when_nonzero_realized_pnl() -> None:
    assert is_opening_fill(trade(realizedPnl="12.5")) is False
    assert is_opening_fill(trade(realizedPnl="-3")) is False


# ---------------------------------------------------------------------------
# find_order_by_id
# ---------------------------------------------------------------------------


def test_find_order_by_id_matches_and_misses() -> None:
    orders = [order(orderId=1), order(orderId=2)]
    assert find_order_by_id(orders, 2) is not None
    assert find_order_by_id(orders, "2") is not None  # string/int coercion
    assert find_order_by_id(orders, 99) is None
    assert find_order_by_id(orders, None) is None


# ---------------------------------------------------------------------------
# close_trigger classification
# ---------------------------------------------------------------------------


def test_close_trigger_liquidation() -> None:
    result = classify_and_enrich(order(type="LIQUIDATION"), exit_price=100.0)
    assert result.close_trigger == CLOSE_TRIGGER_LIQUIDATION


def test_close_trigger_sl_hit_computes_slippage() -> None:
    result = classify_and_enrich(
        order(type="STOP_MARKET", stopPrice="99.0"), exit_price=98.5
    )
    assert result.close_trigger == CLOSE_TRIGGER_SL_HIT
    assert result.stop_loss == 99.0
    assert result.sl_slippage == 98.5 - 99.0


def test_close_trigger_tp_hit_computes_slippage() -> None:
    result = classify_and_enrich(
        order(type="TAKE_PROFIT_MARKET", stopPrice="105.0"), exit_price=105.4
    )
    assert result.close_trigger == CLOSE_TRIGGER_TP_HIT
    assert result.take_profit == 105.0
    assert result.tp_slippage == 105.4 - 105.0


def test_close_trigger_manual_limit() -> None:
    result = classify_and_enrich(order(type="LIMIT"), exit_price=100.0)
    assert result.close_trigger == CLOSE_TRIGGER_MANUAL_LIMIT


def test_close_trigger_manual_market_default() -> None:
    result = classify_and_enrich(order(type="MARKET"), exit_price=100.0)
    assert result.close_trigger == CLOSE_TRIGGER_MANUAL_MARKET


def test_close_trigger_manual_market_when_no_order_matched() -> None:
    result = classify_and_enrich(None, exit_price=100.0)
    assert result.close_trigger == CLOSE_TRIGGER_MANUAL_MARKET


# ---------------------------------------------------------------------------
# Real open-time + weighted entry-price reconstruction
# ---------------------------------------------------------------------------


def test_resolve_real_open_time_single_fill_computes_entry_price() -> None:
    close_ms = BASE_MS + 100_000
    trades = [
        trade(id=1, side="BUY", realizedPnl="0", price="100", qty="1.0", time=BASE_MS),
    ]
    # Closing side "SELL" means the position was opened with "BUY".
    result = resolve_real_open_time(trades, closing_side="SELL", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_USER_TRADES
    assert result.opened_at_ms == BASE_MS
    assert result.weighted_entry_price == 100.0


def test_resolve_real_open_time_accumulates_across_partial_fills() -> None:
    close_ms = BASE_MS + 100_000
    trades = [
        trade(id=1, side="BUY", realizedPnl="0", price="110", qty="0.6", time=BASE_MS + 20_000),
        trade(id=2, side="BUY", realizedPnl="0", price="90", qty="0.6", time=BASE_MS),
    ]
    result = resolve_real_open_time(trades, closing_side="SELL", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_USER_TRADES
    # Walking newest -> oldest: 0.6 (not enough) then +0.6 = 1.2 >= 1.0.
    assert result.opened_at_ms == BASE_MS
    # Weighted avg over the *accumulated* fills used (both, since 0.6 alone
    # doesn't meet closed_size): (110*0.6 + 90*0.6) / 1.2 == 100.
    assert result.weighted_entry_price == 100.0


def test_resolve_real_open_time_ignores_closing_fills_and_wrong_side() -> None:
    close_ms = BASE_MS + 100_000
    trades = [
        trade(
            id=1, side="BUY", realizedPnl="5.0", price="100", qty="1.0", time=BASE_MS
        ),  # excluded: nonzero realizedPnl -> a closing fill, not opening
        trade(
            id=2, side="SELL", realizedPnl="0", price="100", qty="1.0", time=BASE_MS
        ),  # excluded: matches closing side, not entry side
    ]
    result = resolve_real_open_time(trades, closing_side="SELL", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_ESTIMATED
    assert result.weighted_entry_price is None


def test_resolve_real_open_time_estimated_fallback_when_unmet() -> None:
    close_ms = BASE_MS + 100_000
    trades = [
        trade(id=1, side="BUY", realizedPnl="0", price="100", qty="0.3", time=BASE_MS),
    ]
    result = resolve_real_open_time(trades, closing_side="SELL", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_ESTIMATED
    assert result.opened_at_ms == close_ms - 5 * 60 * 1000
    assert result.weighted_entry_price is None


def test_resolve_real_open_time_no_trades_estimated_fallback() -> None:
    close_ms = BASE_MS + 100_000
    result = resolve_real_open_time([], closing_side="SELL", closed_size=1.0, close_ms=close_ms)
    assert result.source == OPEN_TIME_SOURCE_ESTIMATED
    assert result.opened_at_ms == close_ms - 5 * 60 * 1000
