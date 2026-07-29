"""News Intelligence API — sentiment endpoints.

Serves AI-powered news sentiment data to the frontend.
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db

from . import repo

router = APIRouter(prefix="/sentiment", tags=["sentiment"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


class AssetSentimentResponse(BaseModel):
    direction: str
    confidence: float
    reason: str | None = None


class MarketSentimentResponse(BaseModel):
    score: float
    label: str
    description: str
    bullish_ratio: float
    bearish_ratio: float
    neutral_ratio: float


class CurrentSentimentResponse(BaseModel):
    snapshotAt: str
    assetSentiments: dict[str, AssetSentimentResponse]
    marketSentiment: MarketSentimentResponse
    keyNarratives: list[str]
    aiBrief: str | None
    headlinesAnalyzed: int
    windowStart: str | None
    windowEnd: str | None
    model: str | None


class HistoryItem(BaseModel):
    snapshotAt: str
    score: float
    label: str
    headlinesAnalyzed: int


class SentimentHistoryResponse(BaseModel):
    data: list[HistoryItem]


class AiBriefResponse(BaseModel):
    brief: str | None
    snapshotAt: str | None


class StatusResponse(BaseModel):
    status: str
    configured: bool
    model: str
    lastRunAt: str | None
    headlinesAnalyzed: int | None


@router.get(
    "/current",
    response_model=CurrentSentimentResponse,
    summary="Latest AI sentiment snapshot",
)
async def get_current_sentiment(db: DbSession) -> CurrentSentimentResponse:
    snapshot = await repo.load_latest_sentiment(db)
    if snapshot is None:
        raise HTTPException(
            status_code=404,
            detail="No sentiment snapshot available yet. The worker runs every ~60 min.",
        )

    return CurrentSentimentResponse(
        snapshotAt=snapshot["snapshotAt"],
        assetSentiments={
            ticker: AssetSentimentResponse(**data)
            for ticker, data in (snapshot.get("assetSentiments") or {}).items()
        },
        marketSentiment=MarketSentimentResponse(**snapshot.get("marketSentiment", {})),
        keyNarratives=snapshot.get("keyNarratives") or [],
        aiBrief=snapshot.get("aiBrief"),
        headlinesAnalyzed=snapshot.get("headlinesAnalyzed", 0),
        windowStart=snapshot.get("windowStart"),
        windowEnd=snapshot.get("windowEnd"),
        model=snapshot.get("model"),
    )


@router.get(
    "/history",
    response_model=SentimentHistoryResponse,
    summary="Sentiment score history for timeline charts",
)
async def get_sentiment_history(
    db: DbSession,
    limit: int = 48,
) -> SentimentHistoryResponse:
    items = await repo.load_sentiment_history(db, limit=min(limit, 168))
    return SentimentHistoryResponse(
        data=[HistoryItem(**item) for item in items]
    )


@router.get(
    "/news-brief",
    response_model=AiBriefResponse,
    summary="Latest AI-generated news brief",
)
async def get_news_brief(db: DbSession) -> AiBriefResponse:
    snapshot = await repo.load_latest_sentiment(db)
    if snapshot is None:
        return AiBriefResponse(brief=None, snapshotAt=None)
    return AiBriefResponse(
        brief=snapshot.get("aiBrief"),
        snapshotAt=snapshot["snapshotAt"],
    )


@router.get(
    "/status",
    response_model=StatusResponse,
    summary="Sentiment engine status",
)
async def get_sentiment_status(db: DbSession) -> StatusResponse:
    from app.config import settings as cfg

    snapshot = await repo.load_latest_sentiment(db)
    return StatusResponse(
        status="active" if snapshot else "awaiting_first_run",
        configured=bool(cfg.LLM_BASE_URL),
        model=cfg.LLM_MODEL,
        lastRunAt=snapshot["snapshotAt"] if snapshot else None,
        headlinesAnalyzed=snapshot.get("headlinesAnalyzed") if snapshot else None,
    )
