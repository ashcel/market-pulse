from app.execution.binance_client import BinanceExecClient
from app.execution.config import execution_settings


def test_binance_exec_client_uses_testnet_url_for_testnet_key() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=True)

    assert client.base_url == execution_settings.BINANCE_TESTNET_FUTURES_URL


def test_binance_exec_client_uses_mainnet_url_for_mainnet_key() -> None:
    client = BinanceExecClient("api-key", "secret", testnet=False)

    assert client.base_url == execution_settings.BINANCE_MAINNET_FUTURES_URL
