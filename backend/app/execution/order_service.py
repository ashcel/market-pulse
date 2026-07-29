import asyncio
import contextlib
import hashlib
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from inspect import isawaitable

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .binance_client import BinanceExecClient
from .config import execution_settings
from .constants import (
    DEFAULT_MARGIN_TYPE,
    ENTRY_DRIFT_MAX_FRACTION_OF_STOP,
    LEVERAGE_SYNC_FAILED,
    MARGIN_TYPE_ISOLATED,
    SL_ORDER_TIMEOUT_SECONDS,
    SL_TIMEOUT_RETRIES,
    VALID_MARGIN_TYPES,
)
from .exceptions import (
    DuplicateIdempotencyKeyError,
    EntryDriftError,
    ExecutionDisabledError,
    ExecutionInProgressError,
    ExecutionNotReadyError,
    PermitAlreadyUsedError,
    PermitExpiredError,
    PermitMismatchError,
    PermitNotFoundError,
    PermitRejectedError,
)
from .exec_key_crypto import decrypt
from .exec_key_service import get_exec_key
from .models import ExecutionRecord, TradePermit
from .sizing import Side, SymbolFilters, size_position

# F4: an injectable async provider of the current mark price for a symbol,
# returning None when unavailable. Injectable so tests stay pure (no network).
MarkPriceProvider = Callable[[str], Awaitable[float | None]]


@dataclass(frozen=True)
class PermitExecutionValues:
    execution_id: str
    permit_id: str
    symbol: str
    side: str
    entry_type: str
    entry_price: float
    stop_price: float
    target_price: float | None
    leverage: float
    risk_percent: float
    quantity: float
    margin_type: str = DEFAULT_MARGIN_TYPE


# MARKET entries: Binance's immediate place_order response can report
# executedQty=0 a beat before the real (async) fill lands (observed live on
# testnet). Poll get_order this many times, this far apart, before giving up
# and leaving the record for the existing reconcile path.
ENTRY_FILL_POLL_ATTEMPTS = 5
ENTRY_FILL_POLL_INTERVAL_SECONDS = 0.4

TERMINAL_EXECUTION_STATUSES = frozenset(
    {
        "PROTECTED",
        "FLATTENED",
        "ENTRY_REJECTED",
        "UNPROTECTED_CRITICAL",
        # F1: leverage/margin could not be synced+confirmed before entry —
        # terminal, entry never submitted.
        LEVERAGE_SYNC_FAILED,
    }
)
RESUMABLE_EXECUTION_STATUSES = frozenset(
    {
        "PENDING_ENTRY",
        "ENTRY_SUBMITTED",
        "ENTRY_CONFIRMED",
        "PROTECTION_SUBMITTED",
        "TP_FAILED",
        "RECONCILIATION_REQUIRED",
    }
)


def _default_symbol_filters(symbol: str) -> SymbolFilters:
    return SymbolFilters(
        symbol=symbol,
        step_size=Decimal("0.001"),
        min_qty=Decimal("0.001"),
        min_notional=Decimal("5.0"),
        tick_size=Decimal("0.01"),
    )


def _decimal(value: object) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"not decimal-compatible: {value!r}") from exc


def _same_decimal(left: object, right: object) -> bool:
    try:
        return _decimal(left) == _decimal(right)
    except ValueError:
        return False


def _order_side(snapshot_side: str) -> str:
    return "BUY" if snapshot_side.lower() == Side.LONG.value else "SELL"


def _side_for_sizing(snapshot_side: str) -> Side:
    return Side.LONG if snapshot_side.lower() == Side.LONG.value else Side.SHORT


def _now() -> datetime:
    return datetime.now(tz=UTC).replace(tzinfo=None)


def _execution_readiness_errors() -> list[str]:
    if not execution_settings.ENABLED:
        return ["execution_disabled"]
    checker = getattr(execution_settings, "execution_readiness_errors", None)
    if callable(checker) and isinstance(
        getattr(execution_settings, "ENCRYPTION_SECRET", None), str
    ):
        return checker()
    return []


def _assert_execution_ready() -> None:
    errors = _execution_readiness_errors()
    if errors == ["execution_disabled"]:
        raise ExecutionDisabledError("Execution disabled")
    if errors:
        raise ExecutionNotReadyError(errors)


def _client_order_ids(idempotency_key: str) -> tuple[str, str, str]:
    # Binance rejects newClientOrderId >= 36 chars (-4015). A permit UUID key
    # ("exec-<uuid>") already blows that with the "_entry" suffix, so collapse
    # any over-long key to a stable 24-char digest (deterministic → idempotent).
    base = idempotency_key
    if len(base) + len("_entry") > 35:
        base = hashlib.sha1(idempotency_key.encode()).hexdigest()[:24]
    return (f"{base}_entry", f"{base}_sl", f"{base}_tp")


def _execution_response(record: ExecutionRecord) -> dict:
    return {
        "execution_id": record.id,
        "entry_order_id": record.entry_order_id,
        "sl_order_id": record.sl_order_id,
        "tp_order_id": record.tp_order_id,
        "flattened": record.flattened,
        "permit_id": record.permit_id,
        "status": record.status,
        "filled_quantity": record.filled_quantity,
        "protected_quantity": record.protected_quantity,
    }


def _append_event(record: ExecutionRecord, event: str, **payload: object) -> None:
    record.event_log = [
        *record.event_log,
        {"at": _now().isoformat(), "event": event, **payload},
    ]


async def _resolve[T](value: T) -> T:
    if isawaitable(value):
        return await value
    return value


async def _mark(
    db: AsyncSession,
    record: ExecutionRecord,
    status: str,
    event: str,
    *,
    error: str | None = None,
    commit: bool = True,
    **extra: object,
) -> None:
    record.status = status
    record.updated_at = _now()
    if error is not None:
        record.last_error = error
    _append_event(record, event, status=status, error=error, **extra)
    if commit:
        await _resolve(db.commit())


def _normalize_margin_type(value: object) -> str:
    text = str(value).upper() if value is not None else ""
    return text if text in VALID_MARGIN_TYPES else DEFAULT_MARGIN_TYPE


def _margin_type_for_record(record: ExecutionRecord) -> str:
    """Recover the judged margin mode for a record.

    ExecutionRecord has no dedicated margin_type column (avoiding a migration
    on the live DB); the mode is stamped into the `permit_consumed` /
    `record_created` event payload at consume time and read back here. Missing
    (older records / bypassed consume) defaults to ISOLATED — the safe mode.
    """
    for event in record.event_log or []:
        if isinstance(event, dict) and event.get("margin_type"):
            return _normalize_margin_type(event["margin_type"])
    return DEFAULT_MARGIN_TYPE


def _expected_position_margin(margin_type: str) -> str:
    # Binance positionRisk reports marginType as lowercase "isolated"/"cross".
    return "isolated" if margin_type.upper() == MARGIN_TYPE_ISOLATED else "cross"


async def _existing_execution_by_idempotency(
    db: AsyncSession,
    user_id: str,
    idempotency_key: str,
) -> ExecutionRecord | None:
    result = await _resolve(
        db.scalar(
            select(ExecutionRecord).where(
                ExecutionRecord.user_id == user_id,
                ExecutionRecord.idempotency_key == idempotency_key,
            )
        )
    )
    return result if isinstance(result, ExecutionRecord) else None


async def _exchange_call(
    db: AsyncSession,
    record: ExecutionRecord,
    label: str,
    awaitable: object,
) -> dict:
    timeout = getattr(execution_settings, "ORDER_TIMEOUT_SECONDS", 10.0)
    if not isinstance(timeout, int | float):
        timeout = 10.0
    try:
        result = await asyncio.wait_for(awaitable, timeout=timeout)
    except TimeoutError:
        record.retry_count = record.retry_count or 0
        record.retry_count += 1
        await _mark(
            db,
            record,
            "RECONCILIATION_REQUIRED",
            f"{label}_timeout",
            error=f"{label} timed out",
        )
        raise
    except Exception as exc:
        record.retry_count = record.retry_count or 0
        record.retry_count += 1
        record.last_error = str(exc)
        _append_event(record, f"{label}_rejected", error=str(exc))
        await _resolve(db.commit())
        raise
    return result


async def _resolve_mark_price(provider: MarkPriceProvider | None, symbol: str) -> float | None:
    if provider is None:
        return None
    try:
        return await provider(symbol)
    except Exception:
        # A transient premiumIndex failure must not harden into a blocked
        # execution — the drift guard simply doesn't apply when the price is
        # unavailable (the 90s TTL still bounds exposure).
        return None


def _entry_drift_exceeds(
    entry_price: float, stop_price: float, mark_price: float | None
) -> tuple[bool, str]:
    if mark_price is None:
        return False, "mark price unavailable — drift not evaluated"
    stop_distance = abs(entry_price - stop_price)
    if stop_distance <= 0:
        return False, "stop distance zero — drift not evaluated"
    drift = abs(mark_price - entry_price)
    bound = ENTRY_DRIFT_MAX_FRACTION_OF_STOP * stop_distance
    exceeded = drift > bound
    detail = (
        f"mark {mark_price} vs entry {entry_price}: drift {drift} "
        f"{'exceeds' if exceeded else 'within'} bound {bound} "
        f"({ENTRY_DRIFT_MAX_FRACTION_OF_STOP} x stop distance {stop_distance})"
    )
    return exceeded, detail


def _default_mark_price_provider(db: AsyncSession, user_id: str) -> MarkPriceProvider:
    """Build the production mark-price provider (F4). Lazily constructs the
    exec client and reads premiumIndex; any failure yields None so the drift
    guard degrades to "not evaluated" rather than blocking."""

    async def _provider(symbol: str) -> float | None:
        key = await get_exec_key(db, user_id)
        secret = decrypt(key.encrypted_secret)
        client = BinanceExecClient(key.api_key, secret, testnet=key.testnet)
        data = await client.get_mark_price(symbol)
        raw = data.get("markPrice") if isinstance(data, dict) else None
        return float(raw) if raw is not None else None

    return _provider


async def _sync_leverage_and_margin(
    db: AsyncSession,
    client: BinanceExecClient,
    record: ExecutionRecord,
) -> bool:
    """F1 — set the judged margin mode + leverage on the exchange, then read
    positionRisk back to confirm both took effect, all *before* entry.

    Returns True only when the read-back confirms the exchange is in the
    requested mode at the requested leverage. On any rejection (e.g. an open
    position blocks a mode change) or a read-back divergence, marks the record
    terminal (`LEVERAGE_SYNC_FAILED`) and returns False — the caller aborts
    and never submits entry against an unconfirmed leverage/mode.
    """
    symbol = record.symbol
    margin_type = _margin_type_for_record(record)
    target_leverage = round(record.leverage) if record.leverage and record.leverage > 0 else 1

    try:
        await client.set_margin_type(symbol, margin_type)
        await client.set_leverage(symbol, target_leverage)
    except Exception as exc:
        await _mark(
            db,
            record,
            LEVERAGE_SYNC_FAILED,
            "leverage_sync_rejected",
            error=str(exc),
            margin_type=margin_type,
            target_leverage=target_leverage,
        )
        return False

    try:
        positions = await client.get_positions(symbol=symbol, include_zero=True)
    except Exception as exc:
        await _mark(
            db,
            record,
            LEVERAGE_SYNC_FAILED,
            "leverage_sync_readback_failed",
            error=str(exc),
        )
        return False

    row = next((p for p in positions if str(p.get("symbol")) == symbol), None)
    expected_margin = _expected_position_margin(margin_type)
    actual_margin = str(row.get("marginType", "")).lower() if row else ""
    actual_leverage_raw = row.get("leverage") if row else None
    try:
        lev_ok = (
            actual_leverage_raw is not None and int(float(actual_leverage_raw)) == target_leverage
        )
    except (TypeError, ValueError):
        lev_ok = False
    margin_ok = actual_margin == expected_margin

    if row is None or not (lev_ok and margin_ok):
        detail = (
            f"leverage/margin readback mismatch for {symbol}: "
            f"leverage={actual_leverage_raw} (want {target_leverage}), "
            f"marginType={actual_margin!r} (want {expected_margin!r})"
        )
        await _mark(
            db,
            record,
            LEVERAGE_SYNC_FAILED,
            "leverage_sync_unconfirmed",
            error=detail,
        )
        return False

    _append_event(record, "leverage_synced", margin_type=margin_type, leverage=target_leverage)
    await _resolve(db.commit())
    return True


async def _submit_stop_loss(
    db: AsyncSession,
    client: BinanceExecClient,
    record: ExecutionRecord,
    sl_side: str,
) -> dict:
    """D1 — submit the protective stop with the tighter SL-leg timeout and
    exactly one immediate retry on timeout before giving up. A non-timeout
    exchange rejection is not retried (it would just fail again); it raises so
    the caller's flatten path runs. If both the initial attempt and its retry
    time out, the final `TimeoutError` propagates and the caller flattens —
    shrinking the worst-case unprotected window versus a bare reconcile.
    """
    timeout = getattr(execution_settings, "SL_ORDER_TIMEOUT_SECONDS", SL_ORDER_TIMEOUT_SECONDS)
    if not isinstance(timeout, int | float) or timeout <= 0:
        timeout = SL_ORDER_TIMEOUT_SECONDS
    attempts = 1 + SL_TIMEOUT_RETRIES
    last_timeout: TimeoutError | None = None

    for attempt in range(attempts):
        try:
            return await asyncio.wait_for(
                client.place_algo_order(
                    record.symbol,
                    sl_side,
                    "STOP_MARKET",
                    trigger_price=record.stop_price,
                    close_position=True,
                    working_type="CONTRACT_PRICE",
                ),
                timeout=timeout,
            )
        except TimeoutError as exc:
            record.retry_count = (record.retry_count or 0) + 1
            _append_event(
                record,
                "stop_loss_timeout",
                attempt=attempt + 1,
                timeout_seconds=timeout,
            )
            await _resolve(db.commit())
            last_timeout = exc
            continue
        except Exception as exc:
            record.retry_count = (record.retry_count or 0) + 1
            record.last_error = str(exc)
            _append_event(record, "stop_loss_rejected", error=str(exc))
            await _resolve(db.commit())
            raise

    raise last_timeout if last_timeout is not None else TimeoutError("stop-loss timed out")


def _derive_execution_values(
    permit: TradePermit,
    *,
    entry_type: str,
) -> PermitExecutionValues:
    proposal = permit.proposal_snapshot
    account_state = permit.account_state_snapshot

    symbol = str(proposal["symbol"]).upper()
    snapshot_side = str(proposal["side"]).lower()
    order_side = _order_side(snapshot_side)
    entry = _decimal(proposal["entry_price"])
    stop = _decimal(proposal["stop_price"])
    target_raw = proposal.get("take_profit_price")
    target = _decimal(target_raw) if target_raw is not None else None
    leverage = _decimal(proposal["leverage"])
    risk_percent = _decimal(proposal["risk_percent"])
    balance = _decimal(account_state["balance"])
    margin_type = _normalize_margin_type(proposal.get("margin_type"))

    sizing = size_position(
        symbol=symbol,
        side=_side_for_sizing(snapshot_side),
        balance=balance,
        entry_price=entry,
        stop_price=stop,
        risk_fraction=risk_percent / Decimal("100"),
        filters=_default_symbol_filters(symbol),
        leverage=leverage,
        margin_type=margin_type,
    )
    if not sizing.approved:
        raise PermitMismatchError(permit.id, ["quantity"])

    return PermitExecutionValues(
        execution_id=str(uuid.uuid4()),
        permit_id=permit.id,
        symbol=symbol,
        side=order_side,
        entry_type=entry_type.upper(),
        entry_price=float(entry),
        stop_price=float(stop),
        target_price=float(target) if target is not None else None,
        leverage=float(leverage),
        risk_percent=float(risk_percent),
        quantity=float(sizing.quantity),
        margin_type=margin_type,
    )


def _mismatched_fields(
    values: PermitExecutionValues,
    *,
    symbol: str,
    side: str,
    entry_type: str,
    entry_price: float,
    stop_price: float,
    leverage: float | None,
    risk_percent: float | None,
) -> list[str]:
    mismatches: list[str] = []
    if symbol.upper() != values.symbol:
        mismatches.append("symbol")
    if side.upper() != values.side:
        mismatches.append("side")
    if entry_type.upper() != values.entry_type:
        mismatches.append("entry_type")
    if not _same_decimal(entry_price, values.entry_price):
        mismatches.append("entry")
    if not _same_decimal(stop_price, values.stop_price):
        mismatches.append("stop")
    if leverage is not None and not _same_decimal(leverage, values.leverage):
        mismatches.append("leverage")
    if risk_percent is not None and not _same_decimal(risk_percent, values.risk_percent):
        mismatches.append("risk")
    return mismatches


async def consume_permit_for_execution(
    db: AsyncSession,
    user_id: str,
    permit_id: str,
    *,
    symbol: str,
    side: str,
    entry_type: str,
    entry_price: float,
    stop_price: float,
    leverage: float | None = None,
    risk_percent: float | None = None,
    idempotency_key: str = "manual-consume",
    mark_price_provider: MarkPriceProvider | None = None,
) -> PermitExecutionValues:
    now = _now()
    entry_cid, sl_cid, tp_cid = _client_order_ids(idempotency_key)
    try:
        result = await db.execute(
            select(TradePermit).where(TradePermit.id == permit_id).with_for_update()
        )
        permit = result.scalar_one_or_none()

        if permit is None or permit.user_id != user_id:
            raise PermitNotFoundError(permit_id)
        if permit.status != "APPROVED":
            raise PermitRejectedError(permit_id)
        if now >= permit.expires_at:
            raise PermitExpiredError(permit_id)
        if permit.consumed_at is not None:
            raise PermitAlreadyUsedError(permit_id)

        values = _derive_execution_values(permit, entry_type=entry_type)
        mismatches = _mismatched_fields(
            values,
            symbol=symbol,
            side=side,
            entry_type=entry_type,
            entry_price=entry_price,
            stop_price=stop_price,
            leverage=leverage,
            risk_percent=risk_percent,
        )
        if mismatches:
            raise PermitMismatchError(permit_id, mismatches)

        # F4 — consume-time entry-drift guard (MARKET entries only; a LIMIT
        # entry's fill price is bounded by its limit). D2 — stamp mark price
        # and permit snapshot-age so the pre-fill delay is measurable.
        mark_price: float | None = None
        drift_exceeded = False
        drift_detail: str | None = None
        if values.entry_type == "MARKET" and mark_price_provider is not None:
            mark_price = await _resolve_mark_price(mark_price_provider, values.symbol)
            drift_exceeded, drift_detail = _entry_drift_exceeds(
                values.entry_price, values.stop_price, mark_price
            )

        snapshot_age_seconds = max((now - permit.evaluated_at).total_seconds(), 0.0)
        record_status = "ENTRY_REJECTED" if drift_exceeded else "PENDING_ENTRY"
        consumed_event: dict[str, object] = {
            "at": now.isoformat(),
            "event": "permit_consumed",
            "status": record_status,
            "margin_type": values.margin_type,
            "snapshot_age_seconds": snapshot_age_seconds,
        }
        if mark_price is not None:
            consumed_event["mark_price_at_consume"] = mark_price
        events: list[dict[str, object]] = [consumed_event]
        if drift_exceeded:
            events.append(
                {
                    "at": now.isoformat(),
                    "event": "entry_drift_rejected",
                    "status": "ENTRY_REJECTED",
                    "reason": "ENTRY_DRIFT",
                    "detail": drift_detail,
                    "mark_price_at_consume": mark_price,
                }
            )

        db.add(
            ExecutionRecord(
                id=values.execution_id,
                permit_id=permit.id,
                user_id=user_id,
                symbol=values.symbol,
                side=values.side,
                entry_type=values.entry_type,
                entry_price=values.entry_price,
                stop_price=values.stop_price,
                target_price=values.target_price,
                leverage=values.leverage,
                risk_percent=values.risk_percent,
                quantity=values.quantity,
                idempotency_key=idempotency_key,
                status=record_status,
                last_error=(f"ENTRY_DRIFT: {drift_detail}" if drift_exceeded else None),
                entry_client_order_id=entry_cid,
                sl_client_order_id=sl_cid,
                tp_client_order_id=tp_cid if values.target_price is not None else None,
                event_log=events,
                created_at=now,
                updated_at=now,
            )
        )
        update_result = await db.execute(
            update(TradePermit)
            .where(TradePermit.id == permit.id, TradePermit.consumed_at.is_(None))
            .values(consumed_at=now, consumed_by_execution_id=values.execution_id)
        )
        if update_result.rowcount != 1:
            raise PermitAlreadyUsedError(permit_id)
        await _resolve(db.commit())
        if drift_exceeded:
            # Permit is spent and the record is already committed as rejected;
            # surface the drift (post-commit, so no rollback) — nothing is
            # submitted.
            raise EntryDriftError(permit_id, drift_detail or "entry price drift too large")
        return values
    except EntryDriftError:
        raise
    except (
        PermitNotFoundError,
        PermitRejectedError,
        PermitExpiredError,
        PermitAlreadyUsedError,
        PermitMismatchError,
    ):
        await db.rollback()
        raise
    except IntegrityError as exc:
        await db.rollback()
        raise PermitAlreadyUsedError(permit_id) from exc


async def place_execution_order(
    db: AsyncSession,
    user_id: str,
    permit_id: str,
    symbol: str,
    side: str,
    entry_type: str,
    entry_price: float,
    stop_price: float,
    target_price: float,
    quantity: float,
    idempotency_key: str,
    leverage: float | None = None,
    risk_percent: float | None = None,
) -> dict:
    _assert_execution_ready()
    # These caller values are intentionally ignored. Executable target and
    # quantity are derived from the persisted permit snapshot after validation.
    del target_price, quantity

    existing = await _existing_execution_by_idempotency(db, user_id, idempotency_key)
    if existing is not None:
        if existing.permit_id != permit_id:
            raise DuplicateIdempotencyKeyError(idempotency_key)
        if existing.status not in TERMINAL_EXECUTION_STATUSES | RESUMABLE_EXECUTION_STATUSES:
            raise ExecutionInProgressError(existing.id)
        if existing.status in TERMINAL_EXECUTION_STATUSES:
            return _execution_response(existing)
        return await _resume_execution(db, user_id, existing)

    values = await consume_permit_for_execution(
        db,
        user_id,
        permit_id,
        symbol=symbol,
        side=side,
        entry_type=entry_type,
        entry_price=entry_price,
        stop_price=stop_price,
        leverage=leverage,
        risk_percent=risk_percent,
        idempotency_key=idempotency_key,
        mark_price_provider=_default_mark_price_provider(db, user_id),
    )
    return await _submit_execution_order(
        db,
        user_id,
        permit_id=values.permit_id,
        symbol=values.symbol,
        side=values.side,
        entry_type=values.entry_type,
        entry_price=values.entry_price,
        stop_price=values.stop_price,
        target_price=values.target_price,
        quantity=values.quantity,
        idempotency_key=idempotency_key,
    )


async def _submit_execution_order(
    db: AsyncSession,
    user_id: str,
    permit_id: str,
    symbol: str,
    side: str,
    entry_type: str,
    entry_price: float,
    stop_price: float,
    target_price: float | None,
    quantity: float,
    idempotency_key: str,
) -> dict:
    record = await _existing_execution_by_idempotency(db, user_id, idempotency_key)
    if record is None:
        entry_cid, sl_cid, tp_cid = _client_order_ids(idempotency_key)
        record = ExecutionRecord(
            id=str(uuid.uuid4()),
            permit_id=permit_id,
            user_id=user_id,
            symbol=symbol,
            side=side,
            entry_type=entry_type,
            entry_price=entry_price,
            stop_price=stop_price,
            target_price=target_price,
            leverage=0,
            risk_percent=0,
            quantity=quantity,
            idempotency_key=idempotency_key,
            status="PENDING_ENTRY",
            entry_client_order_id=entry_cid,
            sl_client_order_id=sl_cid,
            tp_client_order_id=tp_cid if target_price is not None else None,
            entry_order_id=None,
            sl_order_id=None,
            tp_order_id=None,
            filled_quantity=0,
            protected_quantity=0,
            flattened=False,
            retry_count=0,
            last_error=None,
            event_log=[],
            created_at=_now(),
            updated_at=_now(),
        )
    return await _resume_execution(db, user_id, record)


async def _resume_execution(db: AsyncSession, user_id: str, record: ExecutionRecord) -> dict:
    if record.user_id != user_id:
        raise PermitNotFoundError(record.permit_id)
    if record.status in TERMINAL_EXECUTION_STATUSES:
        return _execution_response(record)

    key = await get_exec_key(db, user_id)
    secret = decrypt(key.encrypted_secret)
    client = BinanceExecClient(key.api_key, secret, testnet=key.testnet)

    symbol = record.symbol
    side = record.side
    quantity = record.quantity

    if record.status == "RECONCILIATION_REQUIRED":
        await _reconcile_execution(db, client, record)
        if record.status in TERMINAL_EXECUTION_STATUSES:
            return _execution_response(record)

    if record.status == "PENDING_ENTRY":
        # F1 — set + confirm margin mode and leverage on the exchange before
        # entry. On failure the record is already marked LEVERAGE_SYNC_FAILED
        # (terminal); abort without submitting entry.
        if not await _sync_leverage_and_margin(db, client, record):
            return _execution_response(record)
        await _mark(db, record, "ENTRY_SUBMITTED", "entry_submit_started")
        try:
            entry = await _exchange_call(
                db,
                record,
                "entry",
                client.place_order(
                    symbol,
                    side,
                    record.entry_type,
                    quantity,
                    # MARKET orders must not carry price/timeInForce (-1106);
                    # LIMIT orders require both (-1102 without timeInForce).
                    price=record.entry_price if record.entry_type == "LIMIT" else None,
                    time_in_force="GTC" if record.entry_type == "LIMIT" else None,
                    new_client_order_id=record.entry_client_order_id,
                ),
            )
            record.entry_order_id = str(entry.get("orderId")) if entry.get("orderId") else None
            filled = _filled_quantity(entry, fallback=0.0)
            status_upper = str(entry.get("status", "")).upper()
            if record.entry_type == "MARKET" and filled <= 0 and status_upper != "FILLED":
                # The immediate response hasn't caught up to the real fill yet.
                # LIMIT entries never take this branch -- they legitimately
                # rest at 0 fill and are left to the existing reconcile path.
                polled = await _await_market_entry_fill(db, client, record)
                if polled is None:
                    # Poll budget exhausted; record stays resumable (see the
                    # RECONCILIATION_REQUIRED mark inside the helper) rather
                    # than being guessed at or flattened.
                    return _execution_response(record)
                filled = polled
            elif filled <= 0 and status_upper == "FILLED":
                # Status confirms a fill but the quantity fields were empty;
                # trust the confirmed status over an absent number.
                filled = quantity
            record.filled_quantity = filled
            await _mark(db, record, "ENTRY_CONFIRMED", "entry_confirmed")
        except TimeoutError:
            return _execution_response(record)
        except Exception:
            await _mark(db, record, "ENTRY_REJECTED", "entry_rejected")
            raise

    if record.status in {"ENTRY_SUBMITTED", "RECONCILIATION_REQUIRED"}:
        await _reconcile_execution(db, client, record)
        if record.status == "RECONCILIATION_REQUIRED":
            return _execution_response(record)

    if record.status in {"ENTRY_CONFIRMED", "TP_FAILED"}:
        sl_side = "SELL" if side == "BUY" else "BUY"
        await _mark(db, record, "PROTECTION_SUBMITTED", "sl_submit_started")
        try:
            # SL/TP conditional orders moved to the Algo Order endpoint on
            # 2025-12-09 -- the old /fapi/v1/order STOP_MARKET/TAKE_PROFIT_MARKET
            # path now returns -4120. closePosition=true closes the whole
            # position on trigger, which is the correct behavior for a single
            # protective stop (no quantity/reduceOnly alongside it).
            #
            # D1: the SL leg has its own tighter timeout + one immediate retry
            # (see `_submit_stop_loss`). A timeout that survives the retry, or
            # any exchange rejection, drops into the flatten path below rather
            # than being left resumable — a stop that can't be placed means the
            # position must not stay open unprotected.
            sl = await _submit_stop_loss(db, client, record, sl_side)
            record.sl_order_id = str(sl.get("algoId")) if sl.get("algoId") else None
            record.protected_quantity = record.filled_quantity or quantity
            await _mark(db, record, "PROTECTED", "stop_loss_confirmed")
        except Exception as exc:
            await _mark(
                db,
                record,
                "UNPROTECTED_CRITICAL",
                "stop_loss_failed",
                error=str(exc),
            )
            await _flatten_unprotected_position(db, client, record)
            return _execution_response(record)

    if record.status == "PROTECTION_SUBMITTED":
        await _reconcile_execution(db, client, record)
        if record.status != "PROTECTED":
            return _execution_response(record)

    if record.status == "PROTECTED" and record.target_price and record.tp_order_id is None:
        try:
            tp_side = "SELL" if side == "BUY" else "BUY"
            tp = await _exchange_call(
                db,
                record,
                "take_profit",
                client.place_algo_order(
                    symbol,
                    tp_side,
                    "TAKE_PROFIT_MARKET",
                    trigger_price=record.target_price,
                    close_position=True,
                    working_type="CONTRACT_PRICE",
                ),
            )
            record.tp_order_id = str(tp.get("algoId")) if tp.get("algoId") else None
            await _mark(db, record, "PROTECTED", "take_profit_confirmed")
        except TimeoutError:
            return _execution_response(record)
        except Exception as exc:
            await _mark(db, record, "TP_FAILED", "take_profit_failed", error=str(exc))

    return _execution_response(record)


def _filled_quantity(order: dict, *, fallback: float) -> float:
    # A present-but-zero executedQty means "not filled yet" -- Binance's
    # immediate MARKET-order response can read executedQty="0" a beat before
    # the real fill lands, and silently returning that 0 is what caused a
    # confirmed fill to be treated as unprotected. Zero at a key falls
    # through to the next one; if nothing yields a positive fill, the
    # caller's fallback decides (0.0 to signal "still unconfirmed", a polled
    # value once one is available, or a resting quantity for LIMIT).
    for key in ("executedQty", "cumQty"):
        raw = order.get(key)
        if raw in (None, ""):
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return fallback


async def _await_market_entry_fill(
    db: AsyncSession,
    client: BinanceExecClient,
    record: ExecutionRecord,
) -> float | None:
    """Poll a just-placed MARKET entry until the exchange reports a real fill.

    Bounded to a handful of short-interval attempts, and wrapped in an
    overall timeout so a hanging get_order call can't stall the request
    indefinitely. On success returns the confirmed fill quantity; on
    exhaustion/timeout marks the record RECONCILIATION_REQUIRED (same
    degrade-gracefully pattern as `_exchange_call`) and returns None so the
    caller does not proceed to place SL/TP against an unconfirmed fill.
    """
    timeout = getattr(execution_settings, "ORDER_TIMEOUT_SECONDS", 10.0)
    if not isinstance(timeout, int | float) or timeout <= 0:
        timeout = 10.0
    budget = min(timeout * 0.8, ENTRY_FILL_POLL_ATTEMPTS * ENTRY_FILL_POLL_INTERVAL_SECONDS)

    async def _poll() -> float | None:
        for attempt in range(ENTRY_FILL_POLL_ATTEMPTS):
            if attempt:
                await asyncio.sleep(ENTRY_FILL_POLL_INTERVAL_SECONDS)
            try:
                polled = await client.get_order(
                    record.symbol,
                    order_id=record.entry_order_id,
                    orig_client_order_id=record.entry_client_order_id,
                )
            except Exception:
                continue
            filled = _filled_quantity(polled, fallback=0.0)
            if filled > 0:
                return filled
            if str(polled.get("status", "")).upper() == "FILLED":
                return filled if filled > 0 else record.quantity
        return None

    try:
        result = await asyncio.wait_for(_poll(), timeout=budget)
    except Exception:
        result = None

    if result is not None:
        return result

    await _mark(
        db,
        record,
        "RECONCILIATION_REQUIRED",
        "entry_fill_poll_exhausted",
        error="entry fill could not be confirmed within poll budget",
    )
    return None


async def _reconcile_execution(
    db: AsyncSession,
    client: BinanceExecClient,
    record: ExecutionRecord,
) -> None:
    try:
        # entry_order_id can already be known (a MARKET entry whose fill poll
        # was exhausted) while filled_quantity is still unconfirmed (0) --
        # that case still needs a lookup, just by order_id instead of the
        # client order id.
        if record.entry_order_id is None or not record.filled_quantity:
            entry = await client.get_order(
                record.symbol,
                order_id=record.entry_order_id,
                orig_client_order_id=record.entry_client_order_id,
            )
            record.entry_order_id = str(entry.get("orderId")) if entry.get("orderId") else None
            record.filled_quantity = _filled_quantity(entry, fallback=record.quantity)
            await _mark(db, record, "ENTRY_CONFIRMED", "entry_reconciled")
        if record.sl_order_id is None and record.status in {"PROTECTION_SUBMITTED"}:
            # The SL is an Algo order now, not a regular one -- it has no
            # origClientOrderId to look up via get_order. Find it in the
            # open algo orders instead, matched by symbol + order type.
            algo_orders = await client.get_open_algo_orders(record.symbol)
            sl = next(
                (
                    order
                    for order in algo_orders
                    if str(order.get("symbol", record.symbol)) == record.symbol
                    and str(order.get("orderType", order.get("type", ""))).upper() == "STOP_MARKET"
                ),
                None,
            )
            if sl is None or sl.get("algoId") is None:
                raise RuntimeError("open algo stop-loss order not found")
            record.sl_order_id = str(sl["algoId"])
            record.protected_quantity = record.filled_quantity or record.quantity
            await _mark(db, record, "PROTECTED", "stop_loss_reconciled")
    except Exception as exc:
        await _mark(
            db,
            record,
            "RECONCILIATION_REQUIRED",
            "reconciliation_failed",
            error=str(exc),
        )


async def _cancel_algo_order_if_present(client: BinanceExecClient, algo_id: str | None) -> None:
    if algo_id is None:
        return
    # Best-effort: a stale/already-triggered algo order failing to cancel
    # must never block the flatten itself.
    with contextlib.suppress(Exception):
        await client.cancel_algo_order(algo_id=algo_id)


async def _flatten_unprotected_position(
    db: AsyncSession,
    client: BinanceExecClient,
    record: ExecutionRecord,
) -> None:
    # An algo SL/TP already placed on this record must not be left dangling
    # once the position is flattened -- cancel each independently so a
    # failure on one doesn't stop the other or the flatten below.
    await _cancel_algo_order_if_present(client, record.sl_order_id)
    await _cancel_algo_order_if_present(client, record.tp_order_id)

    close_side = "SELL" if record.side == "BUY" else "BUY"
    try:
        await _mark(db, record, "FLATTEN_SUBMITTED", "flatten_started")
        await _exchange_call(
            db,
            record,
            "flatten",
            client.place_order(
                record.symbol,
                close_side,
                "MARKET",
                record.filled_quantity or record.quantity,
                reduce_only=True,
            ),
        )
        record.flattened = True
        await _mark(db, record, "FLATTENED", "flatten_confirmed")
    except Exception as exc:
        await _mark(
            db,
            record,
            "UNPROTECTED_CRITICAL",
            "flatten_failed",
            error=str(exc),
        )
