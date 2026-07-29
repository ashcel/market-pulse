from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Signal, Token


async def list_tokens(
    db: AsyncSession, page: int = 1, per_page: int = 20
) -> tuple[list[Token], int]:
    offset = (page - 1) * per_page
    count_q = select(func.count(Token.id))
    total = (await db.execute(count_q)).scalar() or 0
    q = select(Token).offset(offset).limit(per_page).order_by(Token.symbol)
    result = await db.execute(q)
    return list(result.scalars().all()), total


async def get_token_by_symbol(db: AsyncSession, symbol: str) -> Token | None:
    result = await db.execute(select(Token).where(Token.symbol == symbol.upper()))
    return result.scalar_one_or_none()


async def list_signals(
    db: AsyncSession,
    token_id: str | None = None,
    status: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[Signal], int]:
    offset = (page - 1) * per_page
    q = select(Signal)
    count_q = select(func.count(Signal.id))
    if token_id:
        q = q.where(Signal.token_id == token_id)
        count_q = count_q.where(Signal.token_id == token_id)
    if status:
        q = q.where(Signal.status == status)
        count_q = count_q.where(Signal.status == status)

    total = (await db.execute(count_q)).scalar() or 0
    q = q.offset(offset).limit(per_page).order_by(Signal.created_at.desc())
    result = await db.execute(q)
    return list(result.scalars().all()), total


async def get_latest_signals(db: AsyncSession, limit: int = 10) -> list[Signal]:
    q = select(Signal).order_by(Signal.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return list(result.scalars().all())
