from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.binance_review.models import BinanceTrade

from .behavior_detectors import TradeRecord


class BehaviorHistoryUnavailableError(RuntimeError):
    pass


async def get_trade_records_for_behavior(
    db: AsyncSession, user_id: str, lookback_days: int = 60
) -> list[TradeRecord]:
    """Fetch trade records for behavior detection."""
    now = datetime.now()
    lookback_date = now - timedelta(days=lookback_days)

    # Fetch from BinanceTrade table (Trade Review's synced Binance history)
    q = (
        select(BinanceTrade)
        .where(BinanceTrade.user_id == user_id)
        .where(BinanceTrade.closed_at >= lookback_date)
        .order_by(BinanceTrade.opened_at.asc())
    )
    try:
        result = await db.execute(q)
    except SQLAlchemyError as exc:
        raise BehaviorHistoryUnavailableError("Trade behavior history unavailable") from exc
    binance_trades = result.scalars().all()

    records = []
    for t in binance_trades:
        notional_size = Decimal(str(t.entry_price)) * Decimal(str(t.quantity))
        records.append(
            TradeRecord(
                symbol=t.symbol,
                opened_at=t.opened_at,
                closed_at=t.closed_at,
                realized_pnl=Decimal(str(t.realized_pnl)),
                notional_size=notional_size,
                risk_percent=Decimal(
                    "0"
                ),  # Synced Binance trade history doesn't track account % risk
                side=t.side,
            )
        )
    return records
