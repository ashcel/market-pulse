from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .exceptions import TradeForbiddenError, TradeNotFoundError
from .models import Trade
from .schemas import TradeCreate, TradeUpdate


async def list_trades(
    db: AsyncSession,
    user_id: str,
    status: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[Trade], int]:
    offset = (page - 1) * per_page
    q = select(Trade).where(Trade.user_id == user_id)
    count_q = select(func.count(Trade.id)).where(Trade.user_id == user_id)
    if status:
        q = q.where(Trade.status == status)
        count_q = count_q.where(Trade.status == status)

    total = (await db.execute(count_q)).scalar() or 0
    q = q.offset(offset).limit(per_page).order_by(Trade.opened_at.desc())
    result = await db.execute(q)
    return list(result.scalars().all()), total


async def get_trade_by_id(
    db: AsyncSession, trade_id: str, user_id: str
) -> Trade:
    result = await db.execute(select(Trade).where(Trade.id == trade_id))
    trade = result.scalar_one_or_none()
    if not trade:
        raise TradeNotFoundError(trade_id)
    if trade.user_id != user_id:
        raise TradeForbiddenError()
    return trade


async def create_trade(
    db: AsyncSession, user_id: str, payload: TradeCreate
) -> Trade:
    trade = Trade(
        user_id=user_id,
        symbol=payload.symbol.upper(),
        direction=payload.direction,
        entry_price=payload.entry_price,
        quantity=payload.quantity,
        leverage=payload.leverage,
        strategy=payload.strategy,
        notes=payload.notes,
        opened_at=payload.opened_at,
    )
    db.add(trade)
    await db.commit()
    await db.refresh(trade)
    return trade


async def update_trade(
    db: AsyncSession, trade_id: str, user_id: str, payload: TradeUpdate
) -> Trade:
    trade = await get_trade_by_id(db, trade_id, user_id)
    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(trade, field, value)
    await db.commit()
    await db.refresh(trade)
    return trade


async def delete_trade(
    db: AsyncSession, trade_id: str, user_id: str
) -> None:
    trade = await get_trade_by_id(db, trade_id, user_id)
    await db.delete(trade)
    await db.commit()
