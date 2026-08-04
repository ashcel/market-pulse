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
