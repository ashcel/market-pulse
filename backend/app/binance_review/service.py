"""Binance USDT-M futures API-key management + realized-PnL sync/enrichment
pipeline for Trade Review.

**Key-storage decision**: this module owns its own read-only key class
(`BinanceReviewKey`), separate from the execution plane's
`app.execution.models.BinanceExecKey`. `execution.exec_key_service.intake_exec_key`
gates mainnet keys behind withdrawal-scope + IP-allowlist hardening checks
that exist specifically to de-risk order placement (M9 / EDR 0020) —
appropriate there, but it would reject a perfectly safe unrestricted-IP
mainnet key whose owner only wants read-only trade history, and ties key
storage to the execution kill-switch's trust model for no reason. Trade
Review never calls a write endpoint, so this module does a lighter check (a
live `get_account()` call to confirm the key/secret pair works) instead.
It still **reuses** `app.execution.binance_client.BinanceExecClient` for the
actual signed HTTP calls, per the task brief — no HMAC client is duplicated,
only the credential-storage/validation policy differs.

`run_sync` is a two-phase pipeline, mirroring the (now-inert) `app.bybit.service`
module this replaces:

  1. Pull `/fapi/v1/income` (incomeType=REALIZED_PNL) for the sync window and
     upsert one placeholder `BinanceTrade` per non-zero event (pnl + symbol +
     close time only — Binance's income feed carries nothing else).
  2. `_enrich_trades` batches the still-"estimated" trades by symbol and
     fetches `/fapi/v1/userTrades` + `/fapi/v1/allOrders` for the affected
     window, matching each income event to its closing fill via the shared
     `tradeId`/`id`, then fills in exit price/quantity/fees/side, the real
     open time + weighted-avg entry price (`enrichment.resolve_real_open_time`),
     and the SL/TP/close-trigger classification (`enrichment.classify_and_enrich`).
"""

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.execution.binance_client import BinanceExecClient

from .config import binance_review_settings
from .constants import (
    API_KEY_STATUS_ACTIVE,
    DEFAULT_LEVERAGE,
    EXCHANGE_TRADE_ID_PREFIX,
    OPEN_TIME_SOURCE_ESTIMATED,
    SYNC_STATUS_FAILED,
    SYNC_STATUS_SUCCESS,
    SYNC_STATUS_SYNCING,
)
from .crypto import decrypt, encrypt
from .enrichment import classify_and_enrich, find_order_by_id, parse_float, resolve_real_open_time
from .exceptions import (
    BinanceReviewCredentialsInvalidError,
    BinanceReviewKeyNotFoundError,
    BinanceReviewSyncForbiddenError,
    BinanceReviewSyncLogNotFoundError,
)
from .models import BinanceReviewKey, BinanceReviewSyncLog, BinanceTrade
from .schemas import BinanceReviewKeyCreate

_SYNC_CHUNK_DAYS = 7
_INCOME_PAGE_LIMIT = 1000
_ENRICH_TIME_BUFFER = timedelta(hours=2)


def mask_api_key(raw: str) -> str:
    if len(raw) <= 4:
        return "****"
    return f"****{raw[-4:]}"


async def get_key(db: AsyncSession, user_id: str) -> BinanceReviewKey:
    result = await db.execute(select(BinanceReviewKey).where(BinanceReviewKey.user_id == user_id))
    key = result.scalar_one_or_none()
    if not key:
        raise BinanceReviewKeyNotFoundError()
    return key


async def save_key(
    db: AsyncSession, user_id: str, payload: BinanceReviewKeyCreate
) -> BinanceReviewKey:
    client = BinanceExecClient(
        payload.api_key, payload.api_secret, testnet=binance_review_settings.TESTNET
    )
    try:
        await client.get_account()
    except Exception as exc:
        raise BinanceReviewCredentialsInvalidError(
            f"Could not verify Binance credentials: {exc}"
        ) from exc

    encrypted_secret = encrypt(payload.api_secret)
    result = await db.execute(select(BinanceReviewKey).where(BinanceReviewKey.user_id == user_id))
    existing = result.scalar_one_or_none()

    key: BinanceReviewKey
    if existing:
        existing.api_key = payload.api_key
        existing.encrypted_secret = encrypted_secret
        existing.status = API_KEY_STATUS_ACTIVE
        key = existing
    else:
        key = BinanceReviewKey(
            user_id=user_id,
            api_key=payload.api_key,
            encrypted_secret=encrypted_secret,
            status=API_KEY_STATUS_ACTIVE,
        )
        db.add(key)

    await db.commit()
    await db.refresh(key)
    return key


async def delete_key(db: AsyncSession, user_id: str) -> None:
    key = await get_key(db, user_id)
    await db.delete(key)
    await db.commit()


async def get_sync_log(db: AsyncSession, sync_id: str, user_id: str) -> BinanceReviewSyncLog:
    result = await db.execute(
        select(BinanceReviewSyncLog).where(BinanceReviewSyncLog.id == sync_id)
    )
    log = result.scalar_one_or_none()
    if not log:
        raise BinanceReviewSyncLogNotFoundError(sync_id)
    if log.user_id != user_id:
        raise BinanceReviewSyncForbiddenError()
    return log


async def list_trades(
    db: AsyncSession,
    user_id: str,
    symbol: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[BinanceTrade], int]:
    offset = (page - 1) * per_page
    q = select(BinanceTrade).where(BinanceTrade.user_id == user_id)
    count_q = select(func.count(BinanceTrade.id)).where(BinanceTrade.user_id == user_id)
    if symbol:
        q = q.where(BinanceTrade.symbol == symbol.upper())
        count_q = count_q.where(BinanceTrade.symbol == symbol.upper())

    total = (await db.execute(count_q)).scalar() or 0
    q = q.offset(offset).limit(per_page).order_by(BinanceTrade.closed_at.desc())
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


async def _fetch_realized_pnl_income(
    client: BinanceExecClient, start_ms: int, end_ms: int
) -> list[dict[str, Any]]:
    """Page through `/fapi/v1/income` (REALIZED_PNL) for one chunk. Binance
    offers no cursor here — page by re-querying from the last row's
    timestamp + 1ms whenever a full page (== the limit) comes back."""
    rows: list[dict[str, Any]] = []
    cursor_start = start_ms
    while True:
        page = await client.get_income_history(
            income_type="REALIZED_PNL",
            start_time=cursor_start,
            end_time=end_ms,
            limit=_INCOME_PAGE_LIMIT,
        )
        if not page:
            break
        rows.extend(page)
        if len(page) < _INCOME_PAGE_LIMIT:
            break
        cursor_start = int(page[-1]["time"]) + 1
        if cursor_start > end_ms:
            break
    return rows


async def _upsert_trade_from_income(db: AsyncSession, user_id: str, row: dict[str, Any]) -> None:
    trade_ref = row.get("tradeId") or row.get("tranId")
    exchange_trade_id = f"{EXCHANGE_TRADE_ID_PREFIX}-{trade_ref}"
    pnl = float(row.get("income") or 0)
    symbol = row.get("symbol", "")
    closed_ms = int(row.get("time") or 0)
    closed_at = datetime.fromtimestamp(closed_ms / 1000)

    result = await db.execute(
        select(BinanceTrade).where(
            BinanceTrade.user_id == user_id, BinanceTrade.exchange_trade_id == exchange_trade_id
        )
    )
    existing = result.scalar_one_or_none()

    if existing:
        existing.symbol = symbol or existing.symbol
        existing.realized_pnl = pnl
        existing.closed_at = closed_at
        existing.raw_income = row
    else:
        db.add(
            BinanceTrade(
                user_id=user_id,
                exchange_trade_id=exchange_trade_id,
                symbol=symbol,
                side="LONG",  # placeholder until enrichment matches the closing fill
                leverage=DEFAULT_LEVERAGE,
                entry_price=0.0,
                exit_price=0.0,
                quantity=0.0,
                realized_pnl=pnl,
                fees=0.0,
                opened_at=closed_at - timedelta(minutes=5),
                open_time_source=OPEN_TIME_SOURCE_ESTIMATED,
                closed_at=closed_at,
                raw_income=row,
            )
        )


async def _enrich_trades(db: AsyncSession, user_id: str, client: BinanceExecClient) -> None:
    result = await db.execute(
        select(BinanceTrade)
        .where(
            BinanceTrade.user_id == user_id,
            BinanceTrade.open_time_source == OPEN_TIME_SOURCE_ESTIMATED,
        )
        .order_by(BinanceTrade.closed_at.desc())
        .limit(binance_review_settings.ENRICH_BATCH_SIZE)
    )
    trades_to_enrich = list(result.scalars().all())
    if not trades_to_enrich:
        return

    by_symbol: dict[str, list[BinanceTrade]] = {}
    for trade in trades_to_enrich:
        by_symbol.setdefault(trade.symbol, []).append(trade)

    for symbol, symbol_trades in by_symbol.items():
        min_closed = min(t.closed_at for t in symbol_trades)
        max_closed = max(t.closed_at for t in symbol_trades)
        start_ms = int((min_closed - _ENRICH_TIME_BUFFER).timestamp() * 1000)
        end_ms = int((max_closed + _ENRICH_TIME_BUFFER).timestamp() * 1000)

        try:
            user_trades = await client.get_user_trades(
                symbol, start_time=start_ms, end_time=end_ms, limit=1000
            )
            orders = await client.get_all_orders(
                symbol, start_time=start_ms, end_time=end_ms, limit=500
            )
        except Exception:
            continue  # leave this symbol's trades "estimated"; retried next sync

        trades_by_id = {str(t.get("id")): t for t in user_trades}

        for trade in symbol_trades:
            trade_ref = (trade.raw_income or {}).get("tradeId")
            matched = trades_by_id.get(str(trade_ref)) if trade_ref is not None else None
            if matched is None:
                continue  # closing fill not in this window yet; retried next sync

            closing_side = matched.get("side", "SELL")
            close_ms = int(trade.closed_at.timestamp() * 1000)

            trade.exit_price = parse_float(matched.get("price")) or trade.exit_price
            trade.quantity = parse_float(matched.get("qty")) or trade.quantity
            trade.fees = parse_float(matched.get("commission")) or trade.fees
            trade.side = "LONG" if closing_side == "SELL" else "SHORT"

            open_result = resolve_real_open_time(
                user_trades, closing_side, trade.quantity, close_ms
            )
            trade.opened_at = datetime.fromtimestamp(open_result.opened_at_ms / 1000)
            trade.open_time_source = open_result.source
            if open_result.weighted_entry_price is not None:
                trade.entry_price = open_result.weighted_entry_price

            closing_order = find_order_by_id(orders, matched.get("orderId"))
            enrichment = classify_and_enrich(closing_order, trade.exit_price)
            trade.stop_loss = enrichment.stop_loss
            trade.take_profit = enrichment.take_profit
            trade.close_trigger = enrichment.close_trigger
            trade.sl_slippage = enrichment.sl_slippage
            trade.tp_slippage = enrichment.tp_slippage

            if trade.entry_price > 0 and trade.quantity > 0 and trade.leverage > 0:
                margin = (trade.quantity * trade.entry_price) / trade.leverage
                trade.roi_percent = (trade.realized_pnl / margin) * 100 if margin > 0 else None

    await db.commit()


async def run_sync(db: AsyncSession, user_id: str) -> BinanceReviewSyncLog:
    key = await get_key(db, user_id)
    secret = decrypt(key.encrypted_secret)
    client = BinanceExecClient(key.api_key, secret, testnet=binance_review_settings.TESTNET)

    log = BinanceReviewSyncLog(user_id=user_id, status=SYNC_STATUS_SYNCING, started_at=datetime.now())
    db.add(log)
    await db.commit()
    await db.refresh(log)
    log_id = log.id  # captured before any rollback expires `log`'s attributes

    try:
        start_ms = (
            int(key.last_sync_at.timestamp() * 1000)
            if key.last_sync_at
            else int(
                (
                    datetime.now() - timedelta(days=binance_review_settings.SYNC_LOOKBACK_DAYS)
                ).timestamp()
                * 1000
            )
        )
        end_ms = int(datetime.now().timestamp() * 1000)

        imported = 0
        for chunk_start, chunk_end in _chunk_time_range(start_ms, end_ms, _SYNC_CHUNK_DAYS):
            rows = await _fetch_realized_pnl_income(client, chunk_start, chunk_end)
            for row in rows:
                if float(row.get("income") or 0) == 0:
                    continue
                await _upsert_trade_from_income(db, user_id, row)
                imported += 1
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
        log_result = await db.execute(
            select(BinanceReviewSyncLog).where(BinanceReviewSyncLog.id == log_id)
        )
        failed_log = log_result.scalar_one()
        failed_log.status = SYNC_STATUS_FAILED
        failed_log.completed_at = datetime.now()
        failed_log.error = str(exc)[:2000]
        await db.commit()
        await db.refresh(failed_log)
        raise
