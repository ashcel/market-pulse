"""Live-evaluate + persisted-list reads for the REACCUMULATION detector.

Live evaluate reuses the exact worker fetch helpers (`fetch_klines` /
`fetch_oi_history`) and the exact pure detector the hourly pass runs, so the
token page never drifts from what gets written to `signal_events` — it just
doesn't wait up to an hour to see it.
"""

from __future__ import annotations

from smc.reaccumulation import ReaccumulationRead, evaluate_reaccumulation
from sqlalchemy.ext.asyncio import AsyncSession

from app.signals.models import SignalEvent
from app.signals.repo import list_signals
from app.worker.binance import drop_unclosed_candle, fetch_klines, fetch_oi_history
from app.worker.patterns_pass import KLINE_LOOKBACK_LIMIT, OI_LOOKBACK_LIMIT, SOURCE


async def evaluate_reaccumulation_live(symbol: str) -> ReaccumulationRead | None:
    ticker = symbol.strip().upper()
    if not ticker:
        return None
    candles = drop_unclosed_candle(
        await fetch_klines(ticker, "1H", limit=KLINE_LOOKBACK_LIMIT, market="perp")
    )
    if not candles:
        return None
    oi_history = await fetch_oi_history(ticker, limit=OI_LOOKBACK_LIMIT)
    return evaluate_reaccumulation(candles, oi_history, symbol=ticker)


async def list_recent_reaccumulations(
    db: AsyncSession, *, symbol: str | None = None, limit: int = 20
) -> list[SignalEvent]:
    return await list_signals(db, source=SOURCE, symbol=symbol, limit=limit)
