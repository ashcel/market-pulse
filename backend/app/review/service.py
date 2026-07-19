from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.binance_review.models import BinanceTrade
from app.binance_review.schemas import BinanceTradeResponse

from .analytics import HourRangeResult, compute_analytics
from .exceptions import ReviewNotFoundError, ReviewTradeForbiddenError, ReviewTradeNotFoundError
from .models import TradeReview
from .schemas import (
    AnalyticsData,
    HourRange,
    RRMetrics,
    SessionSplit,
    SessionStats,
    StyleBucket,
    StyleBuckets,
    StyleSuitability,
    TradeReviewCreate,
)


def _hour_range(result: HourRangeResult | None) -> HourRange | None:
    if result is None:
        return None
    return HourRange(
        start_hour_utc=result.start_hour_utc,
        end_hour_utc=result.end_hour_utc,
        win_rate=result.win_rate,
        sample_size=result.sample_size,
    )


async def _get_owned_trade(db: AsyncSession, binance_trade_id: str, user_id: str) -> BinanceTrade:
    result = await db.execute(select(BinanceTrade).where(BinanceTrade.id == binance_trade_id))
    trade = result.scalar_one_or_none()
    if not trade:
        raise ReviewTradeNotFoundError(binance_trade_id)
    if trade.user_id != user_id:
        raise ReviewTradeForbiddenError()
    return trade


async def get_analytics(
    db: AsyncSession,
    user_id: str,
    symbol: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
) -> AnalyticsData:
    q = select(BinanceTrade).where(BinanceTrade.user_id == user_id)
    if symbol:
        q = q.where(BinanceTrade.symbol == symbol.upper())
    if start:
        q = q.where(BinanceTrade.closed_at >= start)
    if end:
        q = q.where(BinanceTrade.closed_at <= end)

    result = await db.execute(q)
    trades = list(result.scalars().all())

    analytics = compute_analytics(trades)

    return AnalyticsData(
        total_trades=analytics.total_trades,
        rr=RRMetrics(
            mode=analytics.rr.mode,
            sample_size=analytics.rr.sample_size,
            coverage=analytics.rr.coverage,
            label=analytics.rr.label,
            avg_r_multiple=analytics.rr.avg_r_multiple,
            payoff_ratio=analytics.rr.payoff_ratio,
            expectancy_pct=analytics.rr.expectancy_pct,
        ),
        best_trade=(
            BinanceTradeResponse.model_validate(analytics.best_trade)
            if analytics.best_trade is not None
            else None
        ),
        worst_trade=(
            BinanceTradeResponse.model_validate(analytics.worst_trade)
            if analytics.worst_trade is not None
            else None
        ),
        time_range=_hour_range(analytics.time_range),
        worst_time_range=_hour_range(analytics.worst_time_range),
        sessions=SessionSplit(
            asia=SessionStats(
                n=analytics.sessions.asia.n,
                win_rate=analytics.sessions.asia.win_rate,
                total_pnl=analytics.sessions.asia.total_pnl,
            ),
            london=SessionStats(
                n=analytics.sessions.london.n,
                win_rate=analytics.sessions.london.win_rate,
                total_pnl=analytics.sessions.london.total_pnl,
            ),
            new_york=SessionStats(
                n=analytics.sessions.new_york.n,
                win_rate=analytics.sessions.new_york.win_rate,
                total_pnl=analytics.sessions.new_york.total_pnl,
            ),
        ),
        style=StyleSuitability(
            buckets=StyleBuckets(
                scalp=StyleBucket(
                    n=analytics.style.buckets.scalp.n,
                    win_rate=analytics.style.buckets.scalp.win_rate,
                    total_pnl=analytics.style.buckets.scalp.total_pnl,
                    expectancy=analytics.style.buckets.scalp.expectancy,
                ),
                intraday=StyleBucket(
                    n=analytics.style.buckets.intraday.n,
                    win_rate=analytics.style.buckets.intraday.win_rate,
                    total_pnl=analytics.style.buckets.intraday.total_pnl,
                    expectancy=analytics.style.buckets.intraday.expectancy,
                ),
                swing=StyleBucket(
                    n=analytics.style.buckets.swing.n,
                    win_rate=analytics.style.buckets.swing.win_rate,
                    total_pnl=analytics.style.buckets.swing.total_pnl,
                    expectancy=analytics.style.buckets.swing.expectancy,
                ),
            ),
            recommended=analytics.style.recommended,
            confidence=analytics.style.confidence,
            data_quality=analytics.style.data_quality,
        ),
        stop_evidence_coverage=analytics.stop_evidence_coverage,
    )


async def save_review(
    db: AsyncSession, user_id: str, binance_trade_id: str, payload: TradeReviewCreate
) -> TradeReview:
    await _get_owned_trade(db, binance_trade_id, user_id)

    result = await db.execute(
        select(func.max(TradeReview.version)).where(
            TradeReview.binance_trade_id == binance_trade_id, TradeReview.user_id == user_id
        )
    )
    prev_max = result.scalar()
    version = (prev_max or 0) + 1

    review = TradeReview(
        binance_trade_id=binance_trade_id,
        user_id=user_id,
        review_mode=payload.review_mode,
        severity_score=payload.severity_score,
        severity_tier=payload.severity_tier,
        grade=payload.grade,
        one_liner=payload.one_liner,
        full_review=payload.full_review,
        model_used=payload.model_used,
        version=version,
        generated_at=datetime.now(),
    )
    db.add(review)
    await db.commit()
    await db.refresh(review)
    return review


async def get_review(db: AsyncSession, user_id: str, binance_trade_id: str) -> TradeReview:
    await _get_owned_trade(db, binance_trade_id, user_id)

    result = await db.execute(
        select(TradeReview)
        .where(TradeReview.binance_trade_id == binance_trade_id, TradeReview.user_id == user_id)
        .order_by(TradeReview.version.desc())
        .limit(1)
    )
    review = result.scalar_one_or_none()
    if not review:
        raise ReviewNotFoundError(binance_trade_id)
    return review
