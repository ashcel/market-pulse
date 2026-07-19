from unittest.mock import AsyncMock

import pytest

from app.execution.binance_client import BinanceExecClient
from app.execution.config import execution_settings


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
