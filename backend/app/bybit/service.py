"""Bybit API-key management + closed-PnL sync/enrichment pipeline.

`run_sync` is intentionally inline rather than split into a dozen tiny
helpers spread across files — SOLID's "single responsibility" here means one
service owns "sync a user's Bybit account", not that each API call gets its
own module. It stays readable by delegating the actual math (leverage guard,
real-open-time reconstruction, SL/TP/close-trigger classification) to the
pure functions in `enrichment.py`.
"""

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .client import BybitClient
from .config import bybit_settings
from .constants import (
    API_KEY_STATUS_ACTIVE,
    CATEGORY_LINEAR,
    ESTIMATED_OPEN_OFFSET_MS,
    EXCHANGE_TRADE_ID_PREFIX,
    OPEN_TIME_SOURCE_ESTIMATED,
    SYNC_STATUS_FAILED,
    SYNC_STATUS_SUCCESS,
    SYNC_STATUS_SYNCING,
)
from .crypto import decrypt, encrypt
from .enrichment import classify_and_enrich, parse_leverage, resolve_real_open_time
from .exceptions import (
    BybitCredentialsInvalidError,
    BybitKeyNotFoundError,
    BybitSyncForbiddenError,
    BybitSyncLogNotFoundError,
    BybitUpstreamError,
)
from .models import BybitApiKey, BybitSyncLog, BybitTrade
from .schemas import BybitApiKeyCreate

_ENRICH_ORDER_HISTORY_MAX_PAGES = 5
_ENRICH_TIME_BUFFER = timedelta(hours=2)


def mask_api_key(raw: str) -> str:
    if len(raw) <= 4:
        return "****"
    return f"****{raw[-4:]}"


async def get_api_key(db: AsyncSession, user_id: str) -> BybitApiKey:
    result = await db.execute(select(BybitApiKey).where(BybitApiKey.user_id == user_id))
    key = result.scalar_one_or_none()
    if not key:
        raise BybitKeyNotFoundError()
    return key


async def save_api_key(
    db: AsyncSession, user_id: str, payload: BybitApiKeyCreate
) -> BybitApiKey:
    client = BybitClient(payload.api_key, payload.api_secret, testnet=bybit_settings.TESTNET)
    try:
        await client.test_connection()
    except BybitUpstreamError as exc:
        raise BybitCredentialsInvalidError(
            f"Could not verify Bybit credentials: {exc.message}"
        ) from exc

    encrypted_secret = encrypt(payload.api_secret)
    result = await db.execute(select(BybitApiKey).where(BybitApiKey.user_id == user_id))
    existing = result.scalar_one_or_none()

    key: BybitApiKey
    if existing:
        existing.api_key = payload.api_key
        existing.encrypted_secret = encrypted_secret
        existing.status = API_KEY_STATUS_ACTIVE
        key = existing
    else:
        key = BybitApiKey(
            user_id=user_id,
            api_key=payload.api_key,
            encrypted_secret=encrypted_secret,
            status=API_KEY_STATUS_ACTIVE,
        )
        db.add(key)

    await db.commit()
    await db.refresh(key)
    return key


async def delete_api_key(db: AsyncSession, user_id: str) -> None:
    key = await get_api_key(db, user_id)
    await db.delete(key)
    await db.commit()


async def get_sync_log(db: AsyncSession, sync_id: str, user_id: str) -> BybitSyncLog:
    result = await db.execute(select(BybitSyncLog).where(BybitSyncLog.id == sync_id))
    log = result.scalar_one_or_none()
    if not log:
        raise BybitSyncLogNotFoundError(sync_id)
    if log.user_id != user_id:
        raise BybitSyncForbiddenError()
    return log


async def list_trades(
    db: AsyncSession,
    user_id: str,
    symbol: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[BybitTrade], int]:
    offset = (page - 1) * per_page
    q = select(BybitTrade).where(BybitTrade.user_id == user_id)
    count_q = select(func.count(BybitTrade.id)).where(BybitTrade.user_id == user_id)
    if symbol:
        q = q.where(BybitTrade.symbol == symbol.upper())
        count_q = count_q.where(BybitTrade.symbol == symbol.upper())

    total = (await db.execute(count_q)).scalar() or 0
    q = q.offset(offset).limit(per_page).order_by(BybitTrade.closed_at.desc())
    result = await db.execute(q)
    return list(result.scalars().all()), total


def _chunk_time_range(start_ms: int, end_ms: int, chunk_days: int) -> list[tuple[int, int]]:
    chunk_ms = chunk_days * 24 * 60 * 60 * 1000
    chunks: list[tuple[int, int]] = []
    current = start_ms
    while current < end_ms:
        next_end = min(current + chunk_ms, end_ms)
        chunks.append((current, next_end))
        current = next_end
    return chunks


async def _upsert_trade_from_closed_pnl(
    db: AsyncSession, user_id: str, row: dict[str, Any]
) -> None:
    exchange_trade_id = f"{EXCHANGE_TRADE_ID_PREFIX}-{row.get('orderId')}"
    qty = float(row.get("closedSize") or 0)
    entry = float(row.get("avgEntryPrice") or 0)
    exit_price = float(row.get("avgExitPrice") or 0)
    pnl = float(row.get("closedPnl") or 0)
    leverage = parse_leverage(row.get("leverage"))
    fees = float(row.get("openFee") or 0) + float(row.get("closeFee") or 0)
    closing_side = row.get("side")
    side = "LONG" if closing_side == "Sell" else "SHORT"

    roi_percent: float | None = None
    if qty > 0 and entry > 0 and leverage > 0:
        margin = (qty * entry) / leverage
        if margin > 0:
            roi_percent = (pnl / margin) * 100

    closed_ms = int(row.get("createdTime") or 0)
    closed_at = datetime.fromtimestamp(closed_ms / 1000)
    opened_at = closed_at - timedelta(milliseconds=ESTIMATED_OPEN_OFFSET_MS)

    result = await db.execute(
        select(BybitTrade).where(
            BybitTrade.user_id == user_id, BybitTrade.exchange_trade_id == exchange_trade_id
        )
    )
    existing = result.scalar_one_or_none()

    if existing:
        existing.symbol = row.get("symbol", existing.symbol)
        existing.side = side
        existing.leverage = leverage
        existing.entry_price = entry
        existing.exit_price = exit_price
        existing.quantity = qty
        existing.realized_pnl = pnl
        existing.roi_percent = roi_percent
        existing.fees = fees
        existing.closed_at = closed_at
        existing.raw_close_pnl = row
    else:
        db.add(
            BybitTrade(
                user_id=user_id,
                exchange_trade_id=exchange_trade_id,
                symbol=row.get("symbol", ""),
                side=side,
                leverage=leverage,
                entry_price=entry,
                exit_price=exit_price,
                quantity=qty,
                realized_pnl=pnl,
                roi_percent=roi_percent,
                fees=fees,
                opened_at=opened_at,
                open_time_source=OPEN_TIME_SOURCE_ESTIMATED,
                closed_at=closed_at,
                raw_close_pnl=row,
            )
        )


async def _fetch_order_history(
    client: BybitClient, symbol: str, start_ms: int, end_ms: int
) -> list[dict[str, Any]]:
    orders: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(_ENRICH_ORDER_HISTORY_MAX_PAGES):
        result = await client.get_order_history(
            category=CATEGORY_LINEAR,
            symbol=symbol,
            limit=200,
            cursor=cursor,
            start_time=start_ms,
            end_time=end_ms,
        )
        page = result.get("list", [])
        orders.extend(page)
        cursor = result.get("nextPageCursor") or None
        if not cursor or not page:
            break
    return orders


async def _enrich_trades(db: AsyncSession, user_id: str, client: BybitClient) -> None:
    result = await db.execute(
        select(BybitTrade)
        .where(
            BybitTrade.user_id == user_id,
            BybitTrade.open_time_source == OPEN_TIME_SOURCE_ESTIMATED,
        )
        .order_by(BybitTrade.closed_at.desc())
        .limit(bybit_settings.ENRICH_BATCH_SIZE)
    )
    trades_to_enrich = list(result.scalars().all())
    if not trades_to_enrich:
        return

    by_symbol: dict[str, list[BybitTrade]] = {}
    for trade in trades_to_enrich:
        by_symbol.setdefault(trade.symbol, []).append(trade)

    for symbol, symbol_trades in by_symbol.items():
        min_closed = min(t.closed_at for t in symbol_trades)
        max_closed = max(t.closed_at for t in symbol_trades)
        start_ms = int((min_closed - _ENRICH_TIME_BUFFER).timestamp() * 1000)
        end_ms = int((max_closed + _ENRICH_TIME_BUFFER).timestamp() * 1000)

        try:
            orders = await _fetch_order_history(client, symbol, start_ms, end_ms)
        except BybitUpstreamError:
            continue  # leave this symbol's trades "estimated"; retried next sync
        if not orders:
            continue

        for trade in symbol_trades:
            close_ms = int(trade.closed_at.timestamp() * 1000)
            closing_side = "Sell" if trade.side == "LONG" else "Buy"
            open_result = resolve_real_open_time(orders, closing_side, trade.quantity, close_ms)
            trade.opened_at = datetime.fromtimestamp(open_result.opened_at_ms / 1000)
            trade.open_time_source = open_result.source

            enrichment = classify_and_enrich(
                orders, open_result.opened_at_ms, close_ms, trade.exit_price
            )
            trade.stop_loss = enrichment.stop_loss
            trade.take_profit = enrichment.take_profit
            trade.close_trigger = enrichment.close_trigger
            trade.sl_slippage = enrichment.sl_slippage
            trade.tp_slippage = enrichment.tp_slippage

    await db.commit()


async def run_sync(db: AsyncSession, user_id: str) -> BybitSyncLog:
    key = await get_api_key(db, user_id)
    secret = decrypt(key.encrypted_secret)
    client = BybitClient(key.api_key, secret, testnet=bybit_settings.TESTNET)

    log = BybitSyncLog(user_id=user_id, status=SYNC_STATUS_SYNCING, started_at=datetime.now())
    db.add(log)
    await db.commit()
    await db.refresh(log)
    log_id = log.id  # captured before any rollback expires `log`'s attributes

    try:
        start_ms = (
            int(key.last_sync_at.timestamp() * 1000)
            if key.last_sync_at
            else int(
                (datetime.now() - timedelta(days=bybit_settings.SYNC_LOOKBACK_DAYS)).timestamp()
                * 1000
            )
        )
        end_ms = int(datetime.now().timestamp() * 1000)

        imported = 0
        for chunk_start, chunk_end in _chunk_time_range(
            start_ms, end_ms, bybit_settings.SYNC_CHUNK_DAYS
        ):
            cursor: str | None = None
            while True:
                result = await client.get_closed_pnl(
                    category=CATEGORY_LINEAR,
                    limit=50,
                    cursor=cursor,
                    start_time=chunk_start,
                    end_time=chunk_end,
                )
                rows = result.get("list", [])
                for row in rows:
                    await _upsert_trade_from_closed_pnl(db, user_id, row)
                    imported += 1
                cursor = result.get("nextPageCursor") or None
                if not cursor or not rows:
                    break

        await db.commit()
        await _enrich_trades(db, user_id, client)

        log.status = SYNC_STATUS_SUCCESS
        log.completed_at = datetime.now()
        log.trades_imported = imported
        key.status = API_KEY_STATUS_ACTIVE
        key.last_sync_at = datetime.now()
        await db.commit()
        await db.refresh(log)
        return log
    except Exception as exc:
        await db.rollback()
        log_result = await db.execute(select(BybitSyncLog).where(BybitSyncLog.id == log_id))
        failed_log = log_result.scalar_one()
        failed_log.status = SYNC_STATUS_FAILED
        failed_log.completed_at = datetime.now()
        failed_log.error = str(exc)[:2000]
        await db.commit()
        await db.refresh(failed_log)
        raise
