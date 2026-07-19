from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bybit.models import BybitTrade

from .behavior_detectors import TradeRecord


async def get_trade_records_for_behavior(
    db: AsyncSession, user_id: str, lookback_days: int = 60
) -> list[TradeRecord]:
    """Fetch trade records for behavior detection."""
    now = datetime.now()
    lookback_date = now - timedelta(days=lookback_days)

    # Fetch from BybitTrade table
    q = (
        select(BybitTrade)
        .where(BybitTrade.user_id == user_id)
        .where(BybitTrade.closed_at >= lookback_date)
        .order_by(BybitTrade.opened_at.asc())
    )
    result = await db.execute(q)
    bybit_trades = result.scalars().all()

    records = []
    for t in bybit_trades:
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
                ),  # Bybit historical trades don't explicitly track account % risk
                side=t.side,
            )
        )
    return records
