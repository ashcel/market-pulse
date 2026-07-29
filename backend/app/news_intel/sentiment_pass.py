"""News sentiment analysis pass — runs inside the arq worker loop.

Collects recent token_event headlines, sends them to DeepSeek Flash for
AI-powered sentiment analysis, and stores the structured result in
sentiment_snapshot table.

Runs on a slower cadence (~60 min default) — news sentiment shifts on
minutes-to-hours, not seconds.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import text as sql_text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

from .llm_client import analyze_sentiment
from .repo import insert_sentiment_snapshot

logger = logging.getLogger("worker")

# Sources to exclude from sentiment analysis — noise or low-signal feeds.
_EXCLUDED_SOURCES = {
    "cnbc-economy",  # Too broad/macro — included via CNBC-top
}


async def run_sentiment_pass(
    db: AsyncSession,
    client: httpx.AsyncClient,
    now: datetime | None = None,
) -> bool:
    """One sentiment analysis pass.

    Returns True if a new snapshot was stored, False if skipped or failed.
    """
    if not settings.LLM_BASE_URL:
        logger.info("[sentiment] LLM endpoint not configured — skipping")
        return False

    ref = now or datetime.now(UTC)
    window_hours = settings.SENTIMENT_WINDOW_HOURS
    window_start = ref - timedelta(hours=window_hours)

    # Collect recent headlines from token_event table
    result = await db.execute(
        sql_text(
            "select title, body, source, published_at, symbol"
            " from token_event"
            " where published_at >= :window_start"
            " order by published_at desc"
            " limit :max_headlines"
        ),
        {
            "window_start": window_start,
            "max_headlines": settings.SENTIMENT_MAX_HEADLINES,
        },
    )

    rows = result.all()
    if not rows:
        logger.info("[sentiment] no headlines found in window — skipping")
        return False

    # Build headline list for LLM
    headlines = []
    for row in rows:
        source = row[2] if row[2] else "unknown"
        if source in _EXCLUDED_SOURCES:
            continue
        headline = {
            "headline": row[0],
            "description": row[1] or "",
            "source": source,
            "published_at": str(row[3]) if row[3] else None,
            "assets": [row[4]] if row[4] else [],
        }
        headlines.append(headline)

    if not headlines:
        logger.info("[sentiment] all headlines filtered out — skipping")
        return False

    logger.info(
        "[sentiment] analyzing %d headlines from %s to %s",
        len(headlines),
        window_start.isoformat(),
        ref.isoformat(),
    )

    # Call LLM
    analysis = await analyze_sentiment(headlines, client)
    if analysis is None:
        logger.warning("[sentiment] LLM analysis returned no result")
        return False

    # Store
    snapshot_id = str(uuid.uuid4())
    await insert_sentiment_snapshot(
        db,
        snapshot_id,
        analysis,
        len(headlines),
        window_start,
        ref,
        settings.LLM_MODEL,
    )

    logger.info(
        "[sentiment] snapshot %s stored — market=%s score=%.0f assets=%d headlines=%d",
        snapshot_id[:8],
        analysis.market_sentiment.label,
        analysis.market_sentiment.score,
        len(analysis.asset_sentiments),
        len(headlines),
    )
    return True
