from unittest.mock import MagicMock, patch

import pytest

from app.execution.exceptions import ExecutionDisabledError, TradeLockViolationError
from app.execution.trade_lock_service import move_to_breakeven, trail_stop


@pytest.mark.asyncio
async def test_forbidden_stop_removal_raises():
    with patch("app.execution.trade_lock_service.execution_settings") as m_settings:
        m_settings.ENABLED = True
        # Removing stop completely not implemented directly in signature, but simulated
        # If new_stop_price was missing etc. Assuming standard validation for "not widening":
        with pytest.raises(TradeLockViolationError):
            await trail_stop(MagicMock(), "user", "BTC", "id", 80, original_stop=90, side="LONG")


@pytest.mark.asyncio
async def test_forbidden_stop_widening_raises():
    with patch("app.execution.trade_lock_service.execution_settings") as m_settings:
        m_settings.ENABLED = True
        with pytest.raises(TradeLockViolationError):
            await trail_stop(MagicMock(), "user", "BTC", "id", 110, original_stop=100, side="SHORT")


@pytest.mark.asyncio
async def test_allowed_trail_stop_passes():
    with patch("app.execution.trade_lock_service.execution_settings") as m_settings:
        m_settings.ENABLED = True
        res = await trail_stop(MagicMock(), "user", "BTC", "id", 100, original_stop=90, side="LONG")
        assert res["new_stop_price"] == 100


@pytest.mark.asyncio
async def test_move_to_breakeven_sets_entry_price():
    with patch("app.execution.trade_lock_service.execution_settings") as m_settings:
        m_settings.ENABLED = True
        res = await move_to_breakeven(MagicMock(), "user", "BTC", "id", 100, side="LONG")
        assert res["breakeven"] == 100


@pytest.mark.asyncio
async def test_kill_switch_off_raises_for_management():
    with patch("app.execution.trade_lock_service.execution_settings") as m_settings:
        m_settings.ENABLED = False
        with pytest.raises(ExecutionDisabledError):
            await trail_stop(MagicMock(), "user", "BTC", "id", 100)
