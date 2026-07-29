"""Persistence for sentiment snapshots — insert + query.

Idempotent by design: the latest snapshot per source is always the newest
inserted row. History is preserved for timeline charts.
"""

from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .llm_client import SentimentAnalysisResult


def _ok() -> str:
    return datetime.utcnow().isoformat()


async def insert_sentiment_snapshot(
    db: AsyncSession,
    snapshot_id: str,
    result: SentimentAnalysisResult,
    headlines_count: int,
    window_start: datetime | None,
    window_end: datetime | None,
    model: str | None,
) -> None:
    """Insert one sentiment analysis snapshot."""
    await db.execute(
        text(
            "insert into sentiment_snapshot"
            " (id, snapshot_at, asset_sentiments, market_sentiment, key_narratives,"
            " ai_brief, headlines_analyzed, window_start, window_end, source, model)"
            " values (:id, :snapshot_at, :asset_sentiments, :market_sentiment,"
            " :key_narratives, :ai_brief, :headlines_analyzed, :window_start,"
            " :window_end, 'ai', :model)"
        ),
        {
            "id": snapshot_id,
            "snapshot_at": datetime.utcnow(),
            "asset_sentiments": json.dumps(
                {
                    ticker: {
                        "direction": s.direction,
                        "confidence": s.confidence,
                        "reason": s.reason,
                    }
                    for ticker, s in result.asset_sentiments.items()
                }
            ),
            "market_sentiment": json.dumps(
                {
                    "score": result.market_sentiment.score,
                    "label": result.market_sentiment.label,
                    "description": result.market_sentiment.description,
                    "bullish_ratio": result.market_sentiment.bullish_ratio,
                    "bearish_ratio": result.market_sentiment.bearish_ratio,
                    "neutral_ratio": result.market_sentiment.neutral_ratio,
                }
            ),
            "key_narratives": json.dumps(result.key_narratives),
            "ai_brief": result.ai_brief,
            "headlines_analyzed": headlines_count,
            "window_start": window_start,
            "window_end": window_end,
            "model": model,
        },
    )
    await db.commit()


async def load_latest_sentiment(db: AsyncSession) -> dict | None:
    """Load the latest sentiment snapshot."""
    result = await db.execute(
        text(
            "select id, snapshot_at, asset_sentiments, market_sentiment,"
            " key_narratives, ai_brief, headlines_analyzed, window_start,"
            " window_end, model"
            " from sentiment_snapshot"
            " order by snapshot_at desc"
            " limit 1"
        )
    )
    row = result.first()
    if row is None:
        return None
    return {
        "id": row[0],
        "snapshotAt": row[1].isoformat() if hasattr(row[1], "isoformat") else str(row[1]),
        "assetSentiments": json.loads(row[2]) if isinstance(row[2], str) else row[2],
        "marketSentiment": json.loads(row[3]) if isinstance(row[3], str) else row[3],
        "keyNarratives": json.loads(row[4]) if isinstance(row[4], str) else row[4],
        "aiBrief": row[5],
        "headlinesAnalyzed": row[6],
        "windowStart": row[7].isoformat() if row[7] and hasattr(row[7], "isoformat") else row[7],
        "windowEnd": row[8].isoformat() if row[8] and hasattr(row[8], "isoformat") else row[8],
        "model": row[9],
    }


async def load_sentiment_history(db: AsyncSession, limit: int = 48) -> list[dict]:
    """Load recent sentiment snapshots for timeline charts."""
    result = await db.execute(
        text(
            "select snapshot_at, market_sentiment, headlines_analyzed"
            " from sentiment_snapshot"
            " order by snapshot_at desc"
            " limit :lim"
        ),
        {"lim": limit},
    )
    rows = []
    for row in result.all():
        ms = json.loads(row[1]) if isinstance(row[1], str) else row[1]
        rows.append({
            "snapshotAt": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
            "score": ms.get("score", 50) if isinstance(ms, dict) else 50,
            "label": ms.get("label", "Neutral") if isinstance(ms, dict) else "Neutral",
            "headlinesAnalyzed": row[2],
        })
    return rows


async def load_latest_ai_brief(db: AsyncSession) -> str | None:
    """Load just the latest AI brief text."""
    result = await db.execute(
        text(
            "select ai_brief from sentiment_snapshot"
            " where ai_brief is not null and ai_brief != ''"
            " order by snapshot_at desc"
            " limit 1"
        )
    )
    row = result.first()
    return row[0] if row else None
