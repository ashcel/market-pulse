from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.execution.exceptions import (
    ExecutionKeyIPNotAllowlistedError,
    ExecutionKeyNotFoundError,
    ExecutionKeyWithdrawalScopeError,
)
from app.execution.exec_key_crypto import decrypt
from app.execution.exec_key_service import get_exec_key, intake_exec_key, mask_api_key
from app.execution.models import BinanceExecKey


def test_mask_api_key():
    assert mask_api_key("123456789") == "*****6789"
    assert mask_api_key("123") == "123"


@pytest.mark.asyncio
@pytest.mark.skip(reason="Execution WIP — see docs/test-baseline.md")
async def test_withdrawal_scope_rejected_by_fixture():
    with patch("app.execution.exec_key_service.BinanceExecClient") as mock_client:
        mock_instance = mock_client.return_value
        mock_instance.get_account = AsyncMock(return_value={"canWithdraw": True})

        with pytest.raises(ExecutionKeyWithdrawalScopeError):
            await intake_exec_key(MagicMock(), "user", "key", "secret")


@pytest.mark.asyncio
async def test_no_withdrawal_scope_passes_fixture():
    with patch("app.execution.exec_key_service.BinanceExecClient") as mock_client:
        mock_instance = mock_client.return_value
        mock_instance.get_account = AsyncMock(
            return_value={"canWithdraw": False, "ipWhiteList": ["1.1.1.1"]}
        )

        db = MagicMock()
        key = await intake_exec_key(db, "user", "key", "secret")
        assert key is not None


@pytest.mark.asyncio
@pytest.mark.skip(reason="Execution WIP — see docs/test-baseline.md")
async def test_ip_not_allowlisted_rejected():
    with patch("app.execution.exec_key_service.BinanceExecClient") as mock_client:
        mock_instance = mock_client.return_value
        mock_instance.get_account = AsyncMock(
            return_value={"canWithdraw": False, "ipWhiteList": []}
        )

        with pytest.raises(ExecutionKeyIPNotAllowlistedError):
            await intake_exec_key(MagicMock(), "user", "key", "secret")


@pytest.mark.asyncio
async def test_plaintext_never_stored():
    with patch("app.execution.exec_key_service.BinanceExecClient") as mock_client:
        mock_instance = mock_client.return_value
        mock_instance.get_account = AsyncMock(
            return_value={"canWithdraw": False, "ipWhiteList": ["1.1.1.1"]}
        )

        db = MagicMock()
        key = await intake_exec_key(db, "user", "key", "secret")
        assert key.encrypted_secret != "secret"
        assert decrypt(key.encrypted_secret) == "secret"


def test_log_redaction():
    key = BinanceExecKey(api_key="123456789")
    # This just ensures we don't return plaintext keys via masking
    assert mask_api_key(key.api_key) == "*****6789"


@pytest.mark.asyncio
async def test_exec_key_not_found_raises():
    db = MagicMock()
    db.scalar.return_value = None
    with pytest.raises(ExecutionKeyNotFoundError):
        await get_exec_key(db, "user")


@pytest.mark.asyncio
async def test_get_exec_key_awaits_async_session_scalar():
    key = BinanceExecKey(user_id="user", api_key="key", encrypted_secret="secret")
    db = MagicMock()
    db.scalar = AsyncMock(return_value=key)

    result = await get_exec_key(db, "user")

    assert result is key
    db.scalar.assert_awaited_once()


@pytest.mark.asyncio
async def test_intake_exec_key_awaits_async_session_commit_and_refresh():
    with patch("app.execution.exec_key_service.BinanceExecClient") as mock_client:
        mock_instance = mock_client.return_value
        mock_instance.get_account = AsyncMock(
            return_value={"canWithdraw": False, "ipWhiteList": ["1.1.1.1"]}
        )
        db = MagicMock()
        db.commit = AsyncMock()
        db.refresh = AsyncMock()

        key = await intake_exec_key(db, "user", "key", "secret")

        assert key.user_id == "user"
        db.commit.assert_awaited_once()
        db.refresh.assert_awaited_once_with(key)
