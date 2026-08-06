"""Consolidated trade view — groups partial fills into logical trades.

Binance Futures reports each partial fill as a separate income event, so a
single closed position can produce 3-5 rows in `binance_trades`. This module
provides a consolidated view that groups fills by (symbol, side, second)
so the UI shows one row per logical trade.
"""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import Select, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.pagination import PaginationMeta
from app.binance_review.models import BinanceTrade
from app.binance_review.schemas import BinanceTradeResponse


def _consolidation_subquery(
    user_id: str,
    symbol: str | None = None,
) -> Select:
    """Build the GROUP BY subquery that collapses fills into logical trades.

    Grouping key: (user_id, symbol, side, closed_at_second)
    """
    closed_second = func.date_trunc("second", BinanceTrade.closed_at).label("closed_second")

    cols = [
        BinanceTrade.user_id,
        BinanceTrade.symbol,
        BinanceTrade.side,
        closed_second,
        func.count(BinanceTrade.id).label("num_fills"),
        func.sum(BinanceTrade.realized_pnl).label("total_pnl"),
        func.sum(BinanceTrade.quantity).label("total_quantity"),
        func.sum(BinanceTrade.fees).label("total_fees"),
        # Weighted average entry price (weighted by quantity)
        func.sum(BinanceTrade.entry_price * BinanceTrade.quantity).label("entry_price_numer"),
        func.sum(BinanceTrade.quantity).label("entry_price_denom"),
        func.max(BinanceTrade.exit_price).label("max_exit_price"),
        func.min(BinanceTrade.opened_at).label("earliest_opened"),
        func.max(BinanceTrade.closed_at).label("latest_closed"),
        func.avg(BinanceTrade.leverage).label("avg_leverage"),
        # First row's exchange_trade_id as representative
        func.min(BinanceTrade.exchange_trade_id).label("representative_xid"),
        func.min(BinanceTrade.id).label("representative_id"),
        func.min(BinanceTrade.created_at).label("earliest_created"),
        func.max(BinanceTrade.updated_at).label("latest_updated"),
    ]

    q = select(*cols).where(BinanceTrade.user_id == user_id)
    if symbol:
        q = q.where(BinanceTrade.symbol == symbol.upper())

    q = q.group_by(
        BinanceTrade.user_id,
        BinanceTrade.symbol,
        BinanceTrade.side,
        closed_second,
    )
    return q


async def count_consolidated(
    db: AsyncSession,
    user_id: str,
    symbol: str | None = None,
) -> int:
    """Count consolidated logical trades (for pagination)."""
    subq = _consolidation_subquery(user_id, symbol=symbol).subquery()
    count_q = select(func.count()).select_from(subq)
    result = await db.execute(count_q)
    return result.scalar() or 0


async def list_consolidated_trades(
    db: AsyncSession,
    user_id: str,
    symbol: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[BinanceTradeResponse], int]:
    """Return consolidated trade rows grouped by (symbol, side, second).

    Each output row represents one logical trade with aggregated PnL, quantity,
    and averaged entry price.  Paginates over the grouped result.
    """
    subq = _consolidation_subquery(user_id, symbol=symbol).subquery()

    # Count
    count_q = select(func.count()).select_from(subq)
    total = (await db.execute(count_q)).scalar() or 0

    # Fetch page — order by the latest closed_at descending
    offset = (page - 1) * per_page
    fetch_q = (
        select(subq)
        .order_by(subq.c.latest_closed.desc())
        .offset(offset)
        .limit(per_page)
    )
    rows = (await db.execute(fetch_q)).all()

    results: list[BinanceTradeResponse] = []
    for row in rows:
        entry_price_numer = row.entry_price_numer or 0.0
        entry_price_denom = row.entry_price_denom or 0.0
        weighted_entry = entry_price_numer / entry_price_denom if entry_price_denom > 0 else 0.0

        total_pnl = row.total_pnl or 0.0
        total_quantity = row.total_quantity or 0.0
        avg_lev = row.avg_leverage or 1.0

        if weighted_entry > 0 and total_quantity > 0 and avg_lev > 0:
            margin = (total_quantity * weighted_entry) / avg_lev
            roi = (total_pnl / margin) * 100 if margin > 0 else None
        else:
            roi = None

        results.append(
            BinanceTradeResponse(
                id=row.representative_id or "",
                user_id=row.user_id,
                symbol=row.symbol,
                side=row.side,
                leverage=round(avg_lev, 1) if isinstance(avg_lev, float) else float(avg_lev),
                entry_price=round(weighted_entry, 8),
                exit_price=round(row.max_exit_price or 0.0, 8),
                quantity=round(total_quantity, 4),
                realized_pnl=round(total_pnl, 8),
                roi_percent=round(roi, 2) if roi is not None else None,
                fees=round(row.total_fees or 0.0, 8),
                opened_at=row.earliest_opened or datetime.min,
                open_time_source="consolidated",
                closed_at=row.latest_closed or datetime.min,
                stop_loss=None,
                take_profit=None,
                close_trigger=None,
                sl_slippage=None,
                tp_slippage=None,
                created_at=row.earliest_created or datetime.min,
                updated_at=row.latest_updated or datetime.min,
            )
        )

    return results, total


async def list_trades_consolidated_paginated(
    db: AsyncSession,
    user_id: str,
    symbol: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[BinanceTradeResponse], int, PaginationMeta]:
    """Convenience wrapper returning data + meta."""
    data, total = await list_consolidated_trades(
        db, user_id=user_id, symbol=symbol, page=page, per_page=per_page,
    )
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return data, total, meta
