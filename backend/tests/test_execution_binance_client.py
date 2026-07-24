from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from app.execution.binance_client import BinanceExecClient
from app.execution.config import execution_settings
from app.execution.constants import BINANCE_NO_NEED_TO_CHANGE_MARGIN_TYPE


def test_binance_exec_client_uses_testnet_url_for_testnet_key() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)

    assert client.base_url == execution_settings.BINANCE_TESTNET_FUTURES_URL


def test_binance_exec_client_uses_mainnet_url_for_mainnet_key() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=False)

    assert client.base_url == execution_settings.BINANCE_MAINNET_FUTURES_URL


@pytest.mark.asyncio
async def test_place_algo_order_close_position_omits_quantity_and_reduce_only() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"algoId": 1000000139987073})

    result = await client.place_algo_order(
        "BTCUSDT",
        "SELL",
        "STOP_MARKET",
        trigger_price=61924.20,
        close_position=True,
        quantity=0.5,
        reduce_only=True,
    )

    client._request.assert_awaited_once_with(
        "POST",
        "/fapi/v1/algoOrder",
        {
            "algoType": "CONDITIONAL",
            "symbol": "BTCUSDT",
            "side": "SELL",
            "type": "STOP_MARKET",
            "triggerPrice": 61924.20,
            "workingType": "CONTRACT_PRICE",
            "closePosition": "true",
        },
    )
    assert result == {"algoId": 1000000139987073}


@pytest.mark.asyncio
async def test_place_algo_order_with_quantity_and_reduce_only() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"algoId": 42})

    await client.place_algo_order(
        "ETHUSDT",
        "BUY",
        "TAKE_PROFIT_MARKET",
        trigger_price=3500.5,
        quantity=1.25,
        reduce_only=True,
        new_client_strategy_id="strat-1",
    )

    client._request.assert_awaited_once_with(
        "POST",
        "/fapi/v1/algoOrder",
        {
            "algoType": "CONDITIONAL",
            "symbol": "ETHUSDT",
            "side": "BUY",
            "type": "TAKE_PROFIT_MARKET",
            "triggerPrice": 3500.5,
            "workingType": "CONTRACT_PRICE",
            "quantity": 1.25,
            "reduceOnly": "true",
            "newClientStrategyId": "strat-1",
        },
    )


@pytest.mark.asyncio
async def test_place_algo_order_without_reduce_only_omits_flag() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"algoId": 7})

    await client.place_algo_order(
        "ETHUSDT",
        "BUY",
        "STOP_MARKET",
        trigger_price=3500.5,
        quantity=1.0,
    )

    sent_params = client._request.await_args.args[2]
    assert "reduceOnly" not in sent_params
    assert "closePosition" not in sent_params
    assert sent_params["quantity"] == 1.0


@pytest.mark.asyncio
async def test_cancel_algo_order_sends_algo_id() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"algoId": 42, "code": "200", "msg": "success"})

    result = await client.cancel_algo_order(algo_id=42)

    client._request.assert_awaited_once_with("DELETE", "/fapi/v1/algoOrder", {"algoId": 42})
    assert result == {"algoId": 42, "code": "200", "msg": "success"}


@pytest.mark.asyncio
async def test_cancel_algo_order_sends_client_algo_id() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"algoId": 42, "code": "200", "msg": "success"})

    await client.cancel_algo_order(client_algo_id="RbC-1")

    client._request.assert_awaited_once_with(
        "DELETE", "/fapi/v1/algoOrder", {"clientAlgoId": "RbC-1"}
    )


@pytest.mark.asyncio
async def test_cancel_algo_order_sends_both_ids_when_provided() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"algoId": 42, "code": "200", "msg": "success"})

    await client.cancel_algo_order(algo_id=42, client_algo_id="RbC-1")

    client._request.assert_awaited_once_with(
        "DELETE", "/fapi/v1/algoOrder", {"algoId": 42, "clientAlgoId": "RbC-1"}
    )


@pytest.mark.asyncio
async def test_get_open_algo_orders_without_symbol() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value=[{"algoId": 1, "algoStatus": "NEW"}])

    result = await client.get_open_algo_orders()

    client._request.assert_awaited_once_with("GET", "/fapi/v1/openAlgoOrders", {})
    assert result == [{"algoId": 1, "algoStatus": "NEW"}]


@pytest.mark.asyncio
async def test_get_open_algo_orders_with_symbol() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value=[])

    await client.get_open_algo_orders(symbol="BTCUSDT")

    client._request.assert_awaited_once_with(
        "GET", "/fapi/v1/openAlgoOrders", {"symbol": "BTCUSDT"}
    )


@pytest.mark.asyncio
async def test_get_user_trades_sends_symbol_and_window() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value=[{"id": 1}])

    result = await client.get_user_trades("BTCUSDT", start_time=1000, end_time=2000, limit=500)

    client._request.assert_awaited_once_with(
        "GET",
        "/fapi/v1/userTrades",
        {"symbol": "BTCUSDT", "limit": 500, "startTime": 1000, "endTime": 2000},
    )
    assert result == [{"id": 1}]


@pytest.mark.asyncio
async def test_get_user_trades_omits_unset_optional_params() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value=[])

    await client.get_user_trades("BTCUSDT")

    client._request.assert_awaited_once_with(
        "GET", "/fapi/v1/userTrades", {"symbol": "BTCUSDT", "limit": 1000}
    )


@pytest.mark.asyncio
async def test_get_all_orders_sends_symbol_and_window() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value=[{"orderId": 1}])

    result = await client.get_all_orders("ETHUSDT", start_time=1000, end_time=2000, limit=200)

    client._request.assert_awaited_once_with(
        "GET",
        "/fapi/v1/allOrders",
        {"symbol": "ETHUSDT", "limit": 200, "startTime": 1000, "endTime": 2000},
    )
    assert result == [{"orderId": 1}]


# ---------------------------------------------------------------------------
# F1 — set_leverage / set_margin_type, and get_positions read-back.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_leverage_posts_int_leverage() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"leverage": 5, "symbol": "BTCUSDT"})

    result = await client.set_leverage("BTCUSDT", 5)

    client._request.assert_awaited_once_with(
        "POST", "/fapi/v1/leverage", {"symbol": "BTCUSDT", "leverage": 5}
    )
    assert result == {"leverage": 5, "symbol": "BTCUSDT"}


@pytest.mark.asyncio
async def test_set_margin_type_posts_margin_type() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"code": 200, "msg": "success"})

    result = await client.set_margin_type("BTCUSDT", "ISOLATED")

    client._request.assert_awaited_once_with(
        "POST", "/fapi/v1/marginType", {"symbol": "BTCUSDT", "marginType": "ISOLATED"}
    )
    assert result == {"code": 200, "msg": "success"}


def _http_status_error(code: int) -> httpx.HTTPStatusError:
    response = MagicMock()
    response.json.return_value = {"code": code, "msg": "..."}
    return httpx.HTTPStatusError("400", request=MagicMock(), response=response)


@pytest.mark.asyncio
async def test_set_margin_type_treats_no_change_needed_as_success() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(
        side_effect=_http_status_error(BINANCE_NO_NEED_TO_CHANGE_MARGIN_TYPE)
    )

    result = await client.set_margin_type("BTCUSDT", "ISOLATED")

    # -4046 "No need to change margin type." is a no-op success, not a failure.
    assert result["noop"] is True


@pytest.mark.asyncio
async def test_set_margin_type_reraises_other_errors() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(side_effect=_http_status_error(-4048))

    with pytest.raises(httpx.HTTPStatusError):
        await client.set_margin_type("BTCUSDT", "CROSSED")


@pytest.mark.asyncio
async def test_get_positions_default_excludes_flat_rows() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(
        return_value=[
            {"symbol": "BTCUSDT", "positionAmt": "0"},
            {"symbol": "ETHUSDT", "positionAmt": "1.5"},
        ]
    )

    result = await client.get_positions()

    assert [p["symbol"] for p in result] == ["ETHUSDT"]


@pytest.mark.asyncio
async def test_get_positions_include_zero_returns_flat_row_for_symbol() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(
        return_value=[
            {"symbol": "BTCUSDT", "positionAmt": "0", "leverage": "3"},
            {"symbol": "ETHUSDT", "positionAmt": "0", "leverage": "5"},
        ]
    )

    result = await client.get_positions(symbol="BTCUSDT", include_zero=True)

    assert len(result) == 1
    assert result[0]["symbol"] == "BTCUSDT"
    assert result[0]["leverage"] == "3"


@pytest.mark.asyncio
async def test_get_mark_price_hits_premium_index() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)
    client._request = AsyncMock(return_value={"symbol": "BTCUSDT", "markPrice": "64950.0"})

    result = await client.get_mark_price("BTCUSDT")

    client._request.assert_awaited_once_with(
        "GET", "/fapi/v1/premiumIndex", {"symbol": "BTCUSDT"}
    )
    assert result["markPrice"] == "64950.0"
