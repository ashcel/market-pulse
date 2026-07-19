import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.execution.exceptions import (
    DuplicateIdempotencyKeyError,
    ExecutionDisabledError,
    ExecutionNotReadyError,
    PermitAlreadyUsedError,
    PermitExpiredError,
    PermitMismatchError,
    PermitNotFoundError,
    PermitRejectedError,
)
from app.execution.models import ExecutionRecord, TradePermit
from app.execution.order_service import (
    PermitExecutionValues,
    _flatten_unprotected_position,
    consume_permit_for_execution,
    place_execution_order,
)


class FakeBinanceClient:
    def __init__(
        self,
        *,
        place_results: list[object] | None = None,
        algo_results: list[object] | None = None,
        order_results: dict[str, dict] | None = None,
        algo_order_results: list[dict] | None = None,
    ) -> None:
        self.place_results = list(place_results or [])
        self.algo_results = list(algo_results or [])
        self.order_results = order_results or {}
        self.algo_order_results = list(algo_order_results or [])
        self.place_calls: list[dict[str, object]] = []
        self.algo_calls: list[dict[str, object]] = []
        self.cancel_algo_calls: list[dict[str, object]] = []
        self.get_order_calls: list[str] = []
        self.get_open_algo_orders_calls: list[str | None] = []

    async def place_order(self, symbol, side, order_type, quantity, **kwargs):
        self.place_calls.append(
            {
                "symbol": symbol,
                "side": side,
                "order_type": order_type,
                "quantity": quantity,
                **kwargs,
            }
        )
        result = self.place_results.pop(0) if self.place_results else {"orderId": order_type}
        if result == "timeout":
            await asyncio.sleep(0.05)
        if isinstance(result, Exception):
            raise result
        return result

    async def place_algo_order(
        self,
        symbol,
        side,
        order_type,
        *,
        trigger_price,
        close_position=False,
        quantity=None,
        working_type="CONTRACT_PRICE",
        reduce_only=False,
        new_client_strategy_id=None,
    ):
        self.algo_calls.append(
            {
                "symbol": symbol,
                "side": side,
                "order_type": order_type,
                "trigger_price": trigger_price,
                "close_position": close_position,
                "quantity": quantity,
                "working_type": working_type,
                "reduce_only": reduce_only,
                "new_client_strategy_id": new_client_strategy_id,
            }
        )
        result = (
            self.algo_results.pop(0)
            if self.algo_results
            else {"algoId": 12345, "algoStatus": "NEW"}
        )
        if result == "timeout":
            await asyncio.sleep(0.05)
        if isinstance(result, Exception):
            raise result
        return result

    async def cancel_algo_order(self, algo_id=None, client_algo_id=None):
        self.cancel_algo_calls.append({"algo_id": algo_id, "client_algo_id": client_algo_id})
        return {"algoId": algo_id, "algoStatus": "CANCELED"}

    async def get_open_algo_orders(self, symbol: str | None = None) -> list[dict]:
        self.get_open_algo_orders_calls.append(symbol)
        return self.algo_order_results

    async def get_order(
        self,
        symbol: str,
        order_id: str | None = None,
        orig_client_order_id: str | None = None,
    ) -> dict:
        del symbol, order_id
        self.get_order_calls.append(orig_client_order_id or "")
        result = self.order_results.get(orig_client_order_id or "")
        if result is None:
            raise RuntimeError("order not found")
        return result


def execution_ready_settings(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "ENABLED": True,
        "ENCRYPTION_SECRET": "non-default-secret",
        "ORDER_TIMEOUT_SECONDS": 1.0,
        "execution_readiness_errors": lambda: [],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def patched_execution_client(fake: FakeBinanceClient):
    return (
        patch("app.execution.order_service.execution_settings", execution_ready_settings()),
        patch(
            "app.execution.order_service.get_exec_key",
            AsyncMock(return_value=MagicMock(encrypted_secret="enc", testnet=True)),
        ),
        patch("app.execution.order_service.decrypt", MagicMock(return_value="secret")),
        patch("app.execution.order_service.BinanceExecClient", MagicMock(return_value=fake)),
    )


def permit_values(**overrides: object) -> PermitExecutionValues:
    defaults: dict[str, object] = {
        "execution_id": "exec-1",
        "permit_id": "permit",
        "symbol": "BTCUSDT",
        "side": "BUY",
        "entry_type": "MARKET",
        "entry_price": 65000.0,
        "stop_price": 64000.0,
        "target_price": 67000.0,
        "leverage": 2.0,
        "risk_percent": 1.0,
        "quantity": 0.1,
    }
    defaults.update(overrides)
    return PermitExecutionValues(**defaults)  # type: ignore[arg-type]


@pytest.fixture
async def session_factory(tmp_path: Path) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    db_path = tmp_path / "execution.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


def approved_permit(
    *,
    permit_id: str = "permit-1",
    user_id: str = "user-1",
    status: str = "APPROVED",
    expires_at: datetime | None = None,
    consumed_at: datetime | None = None,
    leverage: str = "2",
) -> TradePermit:
    now = datetime.now(tz=UTC).replace(tzinfo=None)
    return TradePermit(
        id=permit_id,
        user_id=user_id,
        symbol="BTCUSDT",
        side="long",
        proposal_snapshot={
            "symbol": "BTCUSDT",
            "side": "long",
            "entry_price": "65000.00",
            "stop_price": "64000.00",
            "take_profit_price": "67000.00",
            "risk_percent": "1.0",
            "leverage": leverage,
            "correlation_bucket": "majors",
            "proposed_notional_percent": "65",
        },
        account_state_snapshot={
            "balance": "10000",
            "open_position_count": 0,
            "daily_realized_pnl_percent": "0",
            "weekly_realized_pnl_percent": "0",
            "exposure_by_bucket_percent": {},
            "active_behavior_flags": [],
            "is_stale": False,
        },
        check_results=[],
        status=status,
        reasons=[] if status == "APPROVED" else ["DAILY_LOSS_LIMIT"],
        quality_score=80.0,
        quality_components=[],
        quality_disclaimer="evaluation, not prediction",
        evaluated_at=now,
        session="london",
        expires_at=expires_at or now + timedelta(seconds=90),
        consumed_at=consumed_at,
        created_at=now,
    )


async def add_permit(
    session_factory: async_sessionmaker[AsyncSession],
    permit: TradePermit,
) -> None:
    async with session_factory() as session:
        session.add(permit)
        await session.commit()


async def consume(
    session: AsyncSession,
    permit_id: str = "permit-1",
    user_id: str = "user-1",
    **overrides: object,
) -> PermitExecutionValues:
    params: dict[str, object] = {
        "symbol": "BTCUSDT",
        "side": "BUY",
        "entry_type": "MARKET",
        "entry_price": 65000.0,
        "stop_price": 64000.0,
        "leverage": 2.0,
        "risk_percent": 1.0,
        "idempotency_key": "manual-consume",
    }
    params.update(overrides)
    return await consume_permit_for_execution(
        session,
        user_id,
        permit_id,
        symbol=params["symbol"],  # type: ignore[arg-type]
        side=params["side"],  # type: ignore[arg-type]
        entry_type=params["entry_type"],  # type: ignore[arg-type]
        entry_price=params["entry_price"],  # type: ignore[arg-type]
        stop_price=params["stop_price"],  # type: ignore[arg-type]
        leverage=params["leverage"],  # type: ignore[arg-type]
        risk_percent=params["risk_percent"],  # type: ignore[arg-type]
        idempotency_key=params["idempotency_key"],  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_kill_switch_off_raises():
    with patch("app.execution.order_service.execution_settings") as m_settings:
        m_settings.ENABLED = False
        with pytest.raises(ExecutionDisabledError):
            await place_execution_order(
                MagicMock(), "user", "permit", "BTC", "BUY", "MARKET", 100, 90, 110, 1, "idem"
            )


@pytest.mark.asyncio
async def test_sl_failure_flattens_position_after_consumption():
    with (
        patch("app.execution.order_service.execution_settings") as m_settings,
        patch("app.execution.order_service.consume_permit_for_execution") as m_consume,
        patch("app.execution.order_service.get_exec_key") as m_key,
        patch("app.execution.order_service.BinanceExecClient") as m_client,
        patch("app.execution.order_service.decrypt") as m_decrypt,
    ):
        m_settings.ENABLED = True
        m_consume.return_value = permit_values()
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.place_order = AsyncMock(
            side_effect=[
                {"orderId": "entry", "executedQty": "0.1"},
                {"orderId": "close"},
            ]
        )
        m_client_inst.place_algo_order = AsyncMock(side_effect=Exception("SL error"))
        m_client_inst.cancel_algo_order = AsyncMock(return_value={"algoStatus": "CANCELED"})

        res = await place_execution_order(
            MagicMock(),
            "user",
            "permit",
            "BTCUSDT",
            "BUY",
            "MARKET",
            65000,
            64000,
            67000,
            999,
            "idem",
        )
        assert res["flattened"]


@pytest.mark.asyncio
async def test_idempotency_key_propagated_after_consumption():
    with (
        patch("app.execution.order_service.execution_settings") as m_settings,
        patch("app.execution.order_service.consume_permit_for_execution") as m_consume,
        patch("app.execution.order_service.get_exec_key") as m_key,
        patch("app.execution.order_service.BinanceExecClient") as m_client,
        patch("app.execution.order_service.decrypt") as m_decrypt,
    ):
        m_settings.ENABLED = True
        m_consume.return_value = permit_values()
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client_inst = m_client.return_value
        m_client_inst.place_order = AsyncMock(return_value={"orderId": "id", "executedQty": "0.1"})
        m_client_inst.place_algo_order = AsyncMock(
            return_value={"algoId": 12345, "algoStatus": "NEW"}
        )

        await place_execution_order(
            MagicMock(),
            "user",
            "permit",
            "BTCUSDT",
            "BUY",
            "MARKET",
            65000,
            64000,
            67000,
            999,
            "idem",
        )
        # MARKET entries must not carry price/timeInForce (Binance -1106).
        m_client_inst.place_order.assert_any_call(
            "BTCUSDT", "BUY", "MARKET", 0.1, price=None, time_in_force=None,
            new_client_order_id="idem_entry"
        )


@pytest.mark.asyncio
async def test_entry_order_references_permit_after_consumption():
    with (
        patch("app.execution.order_service.execution_settings") as m_settings,
        patch("app.execution.order_service.consume_permit_for_execution") as m_consume,
        patch("app.execution.order_service.get_exec_key") as m_key,
        patch("app.execution.order_service.BinanceExecClient") as m_client,
        patch("app.execution.order_service.decrypt") as m_decrypt,
    ):
        m_settings.ENABLED = True
        m_consume.return_value = permit_values(permit_id="permit_123")
        m_key.return_value = MagicMock(encrypted_secret="enc", testnet=True)
        m_decrypt.return_value = "secret"
        m_client.return_value.place_order = AsyncMock(
            return_value={"orderId": "id", "executedQty": "0.1"}
        )
        m_client.return_value.place_algo_order = AsyncMock(
            return_value={"algoId": 12345, "algoStatus": "NEW"}
        )

        res = await place_execution_order(
            MagicMock(),
            "user",
            "permit_123",
            "BTCUSDT",
            "BUY",
            "MARKET",
            65000,
            64000,
            67000,
            999,
            "idem",
        )
        assert res["permit_id"] == "permit_123"


@pytest.mark.asyncio
async def test_expired_permit_rejected(session_factory):
    expired_at = datetime.now(tz=UTC).replace(tzinfo=None) - timedelta(seconds=1)
    await add_permit(
        session_factory,
        approved_permit(expires_at=expired_at),
    )
    async with session_factory() as session:
        with pytest.raises(PermitExpiredError):
            await consume(session)


@pytest.mark.asyncio
async def test_reused_permit_rejected(session_factory):
    await add_permit(
        session_factory,
        approved_permit(consumed_at=datetime.now(tz=UTC).replace(tzinfo=None)),
    )
    async with session_factory() as session:
        with pytest.raises(PermitAlreadyUsedError):
            await consume(session)


@pytest.mark.asyncio
async def test_concurrent_requests_only_one_consumes(session_factory):
    await add_permit(session_factory, approved_permit())

    async def attempt() -> object:
        async with session_factory() as session:
            try:
                return await consume(session)
            except Exception as exc:
                return exc

    results = await asyncio.gather(attempt(), attempt())

    successes = [r for r in results if isinstance(r, PermitExecutionValues)]
    already_used = [r for r in results if isinstance(r, PermitAlreadyUsedError)]
    assert len(successes) == 1
    assert len(already_used) == 1

    async with session_factory() as session:
        records = (await session.execute(select(ExecutionRecord))).scalars().all()
        assert len(records) == 1


@pytest.mark.asyncio
async def test_modified_quantity_is_ignored(session_factory):
    await add_permit(session_factory, approved_permit())
    submit = AsyncMock(return_value={"permit_id": "permit-1"})
    with (
        patch("app.execution.order_service.execution_settings") as m_settings,
        patch("app.execution.order_service._submit_execution_order", submit),
    ):
        m_settings.ENABLED = True
        async with session_factory() as session:
            await place_execution_order(
                session,
                "user-1",
                "permit-1",
                "BTCUSDT",
                "BUY",
                "MARKET",
                65000,
                64000,
                67000,
                999999,
                "idem",
                leverage=2,
                risk_percent=1,
            )

    assert submit.call_args.kwargs["quantity"] == 0.1


@pytest.mark.asyncio
async def test_modified_stop_rejected(session_factory):
    await add_permit(session_factory, approved_permit())
    async with session_factory() as session:
        with pytest.raises(PermitMismatchError) as exc:
            await consume(session, stop_price=63000.0)
    assert exc.value.details == {"fields": ["stop"]}


@pytest.mark.asyncio
async def test_modified_leverage_rejected(session_factory):
    await add_permit(session_factory, approved_permit())
    async with session_factory() as session:
        with pytest.raises(PermitMismatchError) as exc:
            await consume(session, leverage=3.0)
    assert exc.value.details == {"fields": ["leverage"]}


@pytest.mark.asyncio
async def test_foreign_permit_rejected_as_not_found(session_factory):
    await add_permit(session_factory, approved_permit(user_id="other-user"))
    async with session_factory() as session:
        with pytest.raises(PermitNotFoundError):
            await consume(session)


@pytest.mark.asyncio
async def test_rejected_permit_cannot_execute(session_factory):
    await add_permit(session_factory, approved_permit(status="REJECTED"))
    async with session_factory() as session:
        with pytest.raises(PermitRejectedError):
            await consume(session)


async def execute_with_real_db(
    session_factory: async_sessionmaker[AsyncSession],
    fake: FakeBinanceClient,
    *,
    permit_id: str = "permit-1",
    idempotency_key: str = "idem-1",
) -> dict:
    settings_patch, key_patch, decrypt_patch, client_patch = patched_execution_client(fake)
    with settings_patch, key_patch, decrypt_patch, client_patch:
        async with session_factory() as session:
            return await place_execution_order(
                session,
                "user-1",
                permit_id,
                "BTCUSDT",
                "BUY",
                "MARKET",
                65000,
                64000,
                67000,
                999999,
                idempotency_key,
                leverage=2,
                risk_percent=1,
            )


@pytest.mark.asyncio
async def test_execution_not_ready_fails_closed_for_default_secret(session_factory):
    await add_permit(session_factory, approved_permit())
    with patch(
        "app.execution.order_service.execution_settings",
        execution_ready_settings(
            execution_readiness_errors=lambda: ["default_encryption_secret"],
        ),
    ):
        async with session_factory() as session:
            with pytest.raises(ExecutionNotReadyError) as exc:
                await place_execution_order(
                    session,
                    "user-1",
                    "permit-1",
                    "BTCUSDT",
                    "BUY",
                    "MARKET",
                    65000,
                    64000,
                    67000,
                    1,
                    "idem",
                    leverage=2,
                    risk_percent=1,
                )
    assert exc.value.details == {"reasons": ["default_encryption_secret"]}


@pytest.mark.asyncio
async def test_execution_not_ready_fails_closed_for_invalid_and_inconsistent_settings(
    session_factory,
):
    await add_permit(session_factory, approved_permit())
    with patch(
        "app.execution.order_service.execution_settings",
        execution_ready_settings(
            execution_readiness_errors=lambda: ["invalid_order_timeout", "mainnet_not_hardened"],
        ),
    ):
        async with session_factory() as session:
            with pytest.raises(ExecutionNotReadyError) as exc:
                await place_execution_order(
                    session,
                    "user-1",
                    "permit-1",
                    "BTCUSDT",
                    "BUY",
                    "MARKET",
                    65000,
                    64000,
                    67000,
                    1,
                    "idem",
                    leverage=2,
                    risk_percent=1,
                )
    assert exc.value.details == {
        "reasons": ["invalid_order_timeout", "mainnet_not_hardened"]
    }


@pytest.mark.asyncio
async def test_duplicate_click_returns_existing_execution_without_resubmitting(session_factory):
    await add_permit(session_factory, approved_permit())
    fake = FakeBinanceClient(
        place_results=[{"orderId": "entry", "executedQty": "0.1"}],
        algo_results=[{"algoId": "sl"}, {"algoId": "tp"}],
    )
    first = await execute_with_real_db(session_factory, fake)
    second = await execute_with_real_db(session_factory, fake)

    assert first["execution_id"] == second["execution_id"]
    assert second["status"] == "PROTECTED"
    assert len(fake.place_calls) == 1
    assert len(fake.algo_calls) == 2


@pytest.mark.asyncio
async def test_duplicate_idempotency_key_for_different_permit_is_rejected(session_factory):
    await add_permit(session_factory, approved_permit(permit_id="permit-1"))
    await add_permit(session_factory, approved_permit(permit_id="permit-2"))
    fake = FakeBinanceClient(
        place_results=[{"orderId": "entry", "executedQty": "0.1"}],
        algo_results=[{"algoId": "sl"}, {"algoId": "tp"}],
    )
    await execute_with_real_db(session_factory, fake, permit_id="permit-1", idempotency_key="same")

    with pytest.raises(DuplicateIdempotencyKeyError):
        await execute_with_real_db(
            session_factory,
            fake,
            permit_id="permit-2",
            idempotency_key="same",
        )


@pytest.mark.asyncio
async def test_duplicate_permit_with_new_idempotency_key_is_rejected(session_factory):
    await add_permit(session_factory, approved_permit())
    first_fake = FakeBinanceClient(
        place_results=[{"orderId": "entry", "executedQty": "0.1"}],
        algo_results=[{"algoId": "sl"}, {"algoId": "tp"}],
    )
    await execute_with_real_db(session_factory, first_fake, idempotency_key="first")

    second_fake = FakeBinanceClient()
    with pytest.raises(PermitAlreadyUsedError):
        await execute_with_real_db(session_factory, second_fake, idempotency_key="second")


@pytest.mark.asyncio
async def test_replay_attack_after_consumption_is_rejected(session_factory):
    await add_permit(session_factory, approved_permit())
    fake = FakeBinanceClient(
        place_results=[{"orderId": "entry", "executedQty": "0.1"}],
        algo_results=[{"algoId": "sl"}, {"algoId": "tp"}],
    )
    await execute_with_real_db(session_factory, fake, idempotency_key="original-click")

    replay = FakeBinanceClient()
    with pytest.raises(PermitAlreadyUsedError):
        await execute_with_real_db(session_factory, replay, idempotency_key="replay-click")


@pytest.mark.asyncio
async def test_entry_timeout_persists_reconciliation_state(session_factory):
    await add_permit(session_factory, approved_permit())
    fake = FakeBinanceClient(place_results=["timeout"])
    settings_patch, key_patch, decrypt_patch, client_patch = patched_execution_client(fake)
    settings_patch.new.ORDER_TIMEOUT_SECONDS = 0.001
    with settings_patch, key_patch, decrypt_patch, client_patch:
        async with session_factory() as session:
            result = await place_execution_order(
                session,
                "user-1",
                "permit-1",
                "BTCUSDT",
                "BUY",
                "MARKET",
                65000,
                64000,
                67000,
                1,
                "timeout-idem",
                leverage=2,
                risk_percent=1,
            )

    assert result["status"] == "RECONCILIATION_REQUIRED"
    async with session_factory() as session:
        record = await session.scalar(select(ExecutionRecord))
        assert record is not None
        assert record.status == "RECONCILIATION_REQUIRED"
        permit = await session.get(TradePermit, "permit-1")
        assert permit is not None
        assert permit.consumed_by_execution_id == record.id


@pytest.mark.asyncio
async def test_retry_after_timeout_recovers_by_client_order_id(session_factory):
    await add_permit(session_factory, approved_permit())
    timeout_fake = FakeBinanceClient(place_results=["timeout"])
    settings_patch, key_patch, decrypt_patch, client_patch = patched_execution_client(timeout_fake)
    settings_patch.new.ORDER_TIMEOUT_SECONDS = 0.001
    with settings_patch, key_patch, decrypt_patch, client_patch:
        async with session_factory() as session:
            await place_execution_order(
                session,
                "user-1",
                "permit-1",
                "BTCUSDT",
                "BUY",
                "MARKET",
                65000,
                64000,
                67000,
                1,
                "retry-idem",
                leverage=2,
                risk_percent=1,
            )

    retry_fake = FakeBinanceClient(
        algo_results=[{"algoId": "sl"}, {"algoId": "tp"}],
        order_results={"retry-idem_entry": {"orderId": "entry", "executedQty": "0.1"}},
    )
    recovered = await execute_with_real_db(
        session_factory,
        retry_fake,
        idempotency_key="retry-idem",
    )

    assert recovered["status"] == "PROTECTED"
    assert retry_fake.get_order_calls == ["retry-idem_entry"]
    assert [c["order_type"] for c in retry_fake.algo_calls] == [
        "STOP_MARKET",
        "TAKE_PROFIT_MARKET",
    ]


@pytest.mark.asyncio
async def test_worker_restart_resumes_entry_confirmed_record(session_factory):
    await add_permit(session_factory, approved_permit())
    async with session_factory() as session:
        values = await consume(
            session,
            idempotency_key="worker-restart",
        )
        record = await session.get(ExecutionRecord, values.execution_id)
        assert record is not None
        record.status = "ENTRY_CONFIRMED"
        record.entry_order_id = "entry"
        record.filled_quantity = record.quantity
        await session.commit()

    fake = FakeBinanceClient(algo_results=[{"algoId": "sl"}, {"algoId": "tp"}])
    result = await execute_with_real_db(
        session_factory,
        fake,
        idempotency_key="worker-restart",
    )
    assert result["status"] == "PROTECTED"
    assert [c["order_type"] for c in fake.algo_calls] == ["STOP_MARKET", "TAKE_PROFIT_MARKET"]


@pytest.mark.asyncio
async def test_process_restart_reconciles_unknown_entry_submission(session_factory):
    await add_permit(session_factory, approved_permit())
    async with session_factory() as session:
        values = await consume(session, idempotency_key="process-restart")
        record = await session.get(ExecutionRecord, values.execution_id)
        assert record is not None
        record.status = "ENTRY_SUBMITTED"
        await session.commit()

    fake = FakeBinanceClient(
        algo_results=[{"algoId": "sl"}, {"algoId": "tp"}],
        order_results={"process-restart_entry": {"orderId": "entry", "executedQty": "0.1"}},
    )
    result = await execute_with_real_db(
        session_factory,
        fake,
        idempotency_key="process-restart",
    )
    assert result["status"] == "PROTECTED"
    assert fake.get_order_calls == ["process-restart_entry"]


@pytest.mark.asyncio
async def test_partial_fill_protects_only_filled_quantity(session_factory):
    await add_permit(session_factory, approved_permit())
    fake = FakeBinanceClient(
        place_results=[{"orderId": "entry", "executedQty": "0.04"}],
        algo_results=[{"algoId": "sl"}, {"algoId": "tp"}],
    )
    result = await execute_with_real_db(session_factory, fake)

    assert result["filled_quantity"] == 0.04
    assert result["protected_quantity"] == 0.04
    # closePosition=true SL/TP orders close the whole position on trigger --
    # no per-order quantity/reduceOnly is sent alongside them.
    assert fake.algo_calls[0]["close_position"] is True
    assert fake.algo_calls[0]["quantity"] is None
    assert fake.algo_calls[0]["trigger_price"] == 64000.0


@pytest.mark.asyncio
async def test_sl_failure_persists_flattened_recovery(session_factory):
    await add_permit(session_factory, approved_permit())
    fake = FakeBinanceClient(
        place_results=[
            {"orderId": "entry", "executedQty": "0.1"},
            {"orderId": "close"},
        ],
        algo_results=[RuntimeError("SL failure")],
    )
    result = await execute_with_real_db(session_factory, fake)

    assert result["status"] == "FLATTENED"
    assert result["flattened"] is True
    assert [c["order_type"] for c in fake.place_calls] == ["MARKET", "MARKET"]
    assert [c["order_type"] for c in fake.algo_calls] == ["STOP_MARKET"]
    # The SL placement itself failed, so no algo order id was ever recorded
    # to cancel -- flatten proceeds straight to the MARKET close (T1's
    # existing behavior), no cancel_algo_order call expected.
    assert fake.cancel_algo_calls == []


@pytest.mark.asyncio
async def test_tp_failure_keeps_stop_protected_state(session_factory):
    await add_permit(session_factory, approved_permit())
    fake = FakeBinanceClient(
        place_results=[{"orderId": "entry", "executedQty": "0.1"}],
        algo_results=[{"algoId": "sl"}, RuntimeError("TP failure")],
    )
    result = await execute_with_real_db(session_factory, fake)

    assert result["status"] == "TP_FAILED"
    assert result["sl_order_id"] == "sl"
    assert result["tp_order_id"] is None


@pytest.mark.asyncio
async def test_exchange_entry_rejection_persists_rejected_state(session_factory):
    await add_permit(session_factory, approved_permit())
    fake = FakeBinanceClient(place_results=[RuntimeError("exchange rejection")])
    with pytest.raises(RuntimeError, match="exchange rejection"):
        await execute_with_real_db(session_factory, fake)

    async with session_factory() as session:
        record = await session.scalar(select(ExecutionRecord))
        assert record is not None
        assert record.status == "ENTRY_REJECTED"


@pytest.mark.asyncio
async def test_reconciliation_recovers_submitted_stop(session_factory):
    await add_permit(session_factory, approved_permit())
    async with session_factory() as session:
        values = await consume(session, idempotency_key="sl-reconcile")
        record = await session.get(ExecutionRecord, values.execution_id)
        assert record is not None
        record.status = "PROTECTION_SUBMITTED"
        record.entry_order_id = "entry"
        record.filled_quantity = record.quantity
        await session.commit()

    fake = FakeBinanceClient(
        algo_results=[{"algoId": "tp"}],
        algo_order_results=[
            {"symbol": "BTCUSDT", "orderType": "STOP_MARKET", "algoId": "sl"}
        ],
    )
    result = await execute_with_real_db(
        session_factory,
        fake,
        idempotency_key="sl-reconcile",
    )
    assert result["status"] == "PROTECTED"
    assert result["sl_order_id"] == "sl"
    assert fake.get_open_algo_orders_calls == ["BTCUSDT"]


@pytest.mark.asyncio
async def test_transaction_rollback_leaves_permit_unconsumed_and_no_execution_record(
    session_factory,
):
    await add_permit(session_factory, approved_permit())
    async with session_factory() as session:
        with pytest.raises(PermitMismatchError):
            await consume(session, stop_price=63000.0, idempotency_key="rollback")

    async with session_factory() as session:
        permit = await session.get(TradePermit, "permit-1")
        records = (await session.execute(select(ExecutionRecord))).scalars().all()
        assert permit is not None
        assert permit.consumed_at is None
        assert records == []


@pytest.mark.asyncio
async def test_kill_during_execution_resumes_without_duplicate_entry(session_factory):
    await add_permit(session_factory, approved_permit())
    async with session_factory() as session:
        values = await consume(session, idempotency_key="kill-retry")
        record = await session.get(ExecutionRecord, values.execution_id)
        assert record is not None
        record.status = "ENTRY_SUBMITTED"
        await session.commit()

    fake = FakeBinanceClient(
        algo_results=[{"algoId": "sl"}, {"algoId": "tp"}],
        order_results={"kill-retry_entry": {"orderId": "entry", "executedQty": "0.1"}},
    )
    result = await execute_with_real_db(session_factory, fake, idempotency_key="kill-retry")
    assert result["status"] == "PROTECTED"
    assert fake.algo_calls[0]["order_type"] == "STOP_MARKET"


@pytest.mark.asyncio
async def test_flatten_cancels_outstanding_algo_sl_and_tp_orders():
    # Exercises _flatten_unprotected_position directly: a position that
    # already has both an algo SL and TP placed must have both canceled
    # (each independently) before/around the MARKET close, so no orphaned
    # trigger order is left resting on the exchange.
    fake = FakeBinanceClient(place_results=[{"orderId": "close"}])
    record = SimpleNamespace(
        symbol="BTCUSDT",
        side="BUY",
        quantity=0.1,
        filled_quantity=0.1,
        sl_order_id="algo-sl-1",
        tp_order_id="algo-tp-1",
        status="UNPROTECTED_CRITICAL",
        updated_at=None,
        last_error=None,
        event_log=[],
        flattened=False,
        retry_count=0,
    )

    await _flatten_unprotected_position(MagicMock(), fake, record)

    assert record.flattened is True
    assert record.status == "FLATTENED"
    assert {c["algo_id"] for c in fake.cancel_algo_calls} == {"algo-sl-1", "algo-tp-1"}
    assert fake.place_calls[0]["order_type"] == "MARKET"


@pytest.mark.asyncio
async def test_flatten_cancel_failure_does_not_block_flatten():
    # A cancel failing (e.g. the algo order already triggered/expired) must
    # not prevent the flatten MARKET close from proceeding.
    fake = FakeBinanceClient(place_results=[{"orderId": "close"}])
    fake.cancel_algo_order = AsyncMock(side_effect=RuntimeError("already gone"))
    record = SimpleNamespace(
        symbol="BTCUSDT",
        side="SELL",
        quantity=0.2,
        filled_quantity=0.2,
        sl_order_id="algo-sl-2",
        tp_order_id=None,
        status="UNPROTECTED_CRITICAL",
        updated_at=None,
        last_error=None,
        event_log=[],
        flattened=False,
        retry_count=0,
    )

    await _flatten_unprotected_position(MagicMock(), fake, record)

    assert record.flattened is True
    assert record.status == "FLATTENED"
    assert fake.place_calls[0]["order_type"] == "MARKET"


@pytest.mark.asyncio
async def test_flatten_with_no_algo_orders_behaves_as_before():
    # Neither id set (e.g. SL placement itself failed) -- no cancel calls,
    # same as pre-algo-order behavior.
    fake = FakeBinanceClient(place_results=[{"orderId": "close"}])
    record = SimpleNamespace(
        symbol="BTCUSDT",
        side="BUY",
        quantity=0.1,
        filled_quantity=0.1,
        sl_order_id=None,
        tp_order_id=None,
        status="UNPROTECTED_CRITICAL",
        updated_at=None,
        last_error=None,
        event_log=[],
        flattened=False,
        retry_count=0,
    )

    await _flatten_unprotected_position(MagicMock(), fake, record)

    assert record.flattened is True
    assert fake.cancel_algo_calls == []


@pytest.mark.asyncio
async def test_filled_market_entry_reaches_protected_via_algo_sl_and_tp(session_factory):
    await add_permit(session_factory, approved_permit())
    fake = FakeBinanceClient(
        place_results=[{"orderId": "entry", "executedQty": "0.1"}],
        algo_results=[{"algoId": 111}, {"algoId": 222}],
    )
    result = await execute_with_real_db(session_factory, fake)

    assert result["status"] == "PROTECTED"
    assert result["sl_order_id"] == "111"
    assert result["tp_order_id"] == "222"
    assert [c["order_type"] for c in fake.algo_calls] == [
        "STOP_MARKET",
        "TAKE_PROFIT_MARKET",
    ]
    assert fake.algo_calls[0]["trigger_price"] == 64000.0
    assert fake.algo_calls[0]["close_position"] is True
    assert fake.algo_calls[1]["trigger_price"] == 67000.0
    assert fake.algo_calls[1]["close_position"] is True
