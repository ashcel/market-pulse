from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import httpx

from app.execution.account_service import _cache, get_account_state


@pytest.mark.asyncio
async def test_account_state_balance_parsed():
    with (
        patch("app.execution.account_service.get_exec_key") as m_key,
        patch("app.execution.account_service.BinanceExecClient") as m_client,
        patch("app.execution.account_service.decrypt") as m_decrypt,
    ):
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.get_balance = AsyncMock(
            return_value=[{"asset": "USDT", "balance": "1000.50"}]
        )
        m_client_inst.get_positions = AsyncMock(return_value=[])
        m_client_inst.get_income_history = AsyncMock(return_value=[])

        state = await get_account_state(
            MagicMock(), "user", MagicMock(ACCOUNT_STATE_MAX_AGE_SECONDS=15)
        )
        assert state.balance == Decimal("1000.50")


@pytest.mark.asyncio
async def test_account_state_open_positions_counted():
    with (
        patch("app.execution.account_service.get_exec_key") as m_key,
        patch("app.execution.account_service.BinanceExecClient") as m_client,
        patch("app.execution.account_service.decrypt") as m_decrypt,
    ):
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.get_balance = AsyncMock(return_value=[])
        m_client_inst.get_positions = AsyncMock(
            return_value=[{"positionAmt": "1.0"}, {"positionAmt": "0.0"}]
        )
        m_client_inst.get_income_history = AsyncMock(return_value=[])

        state = await get_account_state(
            MagicMock(), "user", MagicMock(ACCOUNT_STATE_MAX_AGE_SECONDS=15)
        )
        assert state.open_position_count == 1


@pytest.mark.asyncio
async def test_account_state_pnl_computed():
    with (
        patch("app.execution.account_service.get_exec_key") as m_key,
        patch("app.execution.account_service.BinanceExecClient") as m_client,
        patch("app.execution.account_service.decrypt") as m_decrypt,
    ):
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.get_balance = AsyncMock(return_value=[{"asset": "USDT", "balance": "100.0"}])
        m_client_inst.get_positions = AsyncMock(return_value=[])
        import time

        now = int(time.time() * 1000)
        m_client_inst.get_income_history = AsyncMock(return_value=[{"time": now, "income": "10.0"}])

        state = await get_account_state(
            MagicMock(), "user", MagicMock(ACCOUNT_STATE_MAX_AGE_SECONDS=15)
        )
        assert state.daily_realized_pnl_percent == Decimal("10.0")
        assert state.weekly_realized_pnl_percent == Decimal("10.0")


@pytest.mark.asyncio
async def test_account_state_failure_without_cache_raises():
    _cache.pop("uncached-user", None)
    with (
        patch("app.execution.account_service.get_exec_key") as m_key,
        patch("app.execution.account_service.BinanceExecClient") as m_client,
        patch("app.execution.account_service.decrypt") as m_decrypt,
    ):
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.get_balance = AsyncMock(
            side_effect=httpx.ConnectError("Network error")
        )

        with pytest.raises(RuntimeError, match="Binance account API unreachable"):
            await get_account_state(
                MagicMock(), "uncached-user", MagicMock(ACCOUNT_STATE_MAX_AGE_SECONDS=15)
            )


@pytest.mark.asyncio
async def test_account_state_stale_on_network_failure_with_recent_cache():
    with (
        patch("app.execution.account_service.get_exec_key") as m_key,
        patch("app.execution.account_service.BinanceExecClient") as m_client,
        patch("app.execution.account_service.decrypt") as m_decrypt,
    ):
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.get_balance = AsyncMock(return_value=[{"asset": "USDT", "balance": "100.0"}])
        m_client_inst.get_positions = AsyncMock(return_value=[])
        m_client_inst.get_income_history = AsyncMock(return_value=[])

        fresh = await get_account_state(
            MagicMock(), "cached-user", MagicMock(ACCOUNT_STATE_MAX_AGE_SECONDS=15)
        )
        assert not fresh.is_stale

        m_client_inst.get_balance = AsyncMock(
            side_effect=httpx.ConnectError("Network error")
        )
        state = await get_account_state(
            MagicMock(), "cached-user", MagicMock(ACCOUNT_STATE_MAX_AGE_SECONDS=15)
        )
        assert state.is_stale


@pytest.mark.asyncio
async def test_exposure_by_bucket():
    with (
        patch("app.execution.account_service.get_exec_key") as m_key,
        patch("app.execution.account_service.BinanceExecClient") as m_client,
        patch("app.execution.account_service.decrypt") as m_decrypt,
    ):
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.get_balance = AsyncMock(return_value=[{"asset": "USDT", "balance": "100.0"}])
        m_client_inst.get_positions = AsyncMock(
            return_value=[
                {"symbol": "BTCUSDT", "positionAmt": "1.0", "markPrice": "50.0"},
                {"symbol": "ETHUSDT", "positionAmt": "1.0", "markPrice": "10.0"},
            ]
        )
        m_client_inst.get_income_history = AsyncMock(return_value=[])

        state = await get_account_state(
            MagicMock(), "user", MagicMock(ACCOUNT_STATE_MAX_AGE_SECONDS=15)
        )
        assert state.exposure_by_bucket_percent["btc"] == Decimal("50.0")
        assert state.exposure_by_bucket_percent["eth"] == Decimal("10.0")


@pytest.mark.asyncio
async def test_exposure_bucket_unknown_symbol_uses_other():
    with (
        patch("app.execution.account_service.get_exec_key") as m_key,
        patch("app.execution.account_service.BinanceExecClient") as m_client,
        patch("app.execution.account_service.decrypt") as m_decrypt,
    ):
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.get_balance = AsyncMock(return_value=[{"asset": "USDT", "balance": "100.0"}])
        m_client_inst.get_positions = AsyncMock(
            return_value=[{"symbol": "UNKNOWN", "positionAmt": "1.0", "markPrice": "50.0"}]
        )
        m_client_inst.get_income_history = AsyncMock(return_value=[])

        state = await get_account_state(
            MagicMock(), "user", MagicMock(ACCOUNT_STATE_MAX_AGE_SECONDS=15)
        )
        assert state.exposure_by_bucket_percent["other"] == Decimal("50.0")
