"""Hourly background Binance Trade-Review sync — one pass over every user
with a connected, active read-only Binance API key.

Replaces `bybit_sync_pass.py` (now unregistered/inert — see app/bybit/).
Each user is synced in its **own** `SessionFactory()` session wrapped in a
per-user try/except: `run_sync` self-manages its commits and re-raises on
failure (recording a FAILED sync log first), so one bad key — expired,
revoked, rate-limited — must not poison the rest of the batch. The review
page already syncs on demand; this pass keeps the record fresh for users who
aren't looking.
"""

from __future__ import annotations

import logging

from sqlalchemy import select

from app.binance_review.constants import API_KEY_STATUS_ACTIVE
from app.binance_review.models import BinanceReviewKey
from app.binance_review.service import run_sync
from app.database import SessionFactory

logger = logging.getLogger("worker")


async def run_binance_review_sync_pass() -> str:
    """Sync every active-keyed user's realized Binance futures PnL once.
    Returns a one-line summary (the heartbeat the arq log reports on)."""
    async with SessionFactory() as db:
        result = await db.execute(
            select(BinanceReviewKey.user_id).where(BinanceReviewKey.status == API_KEY_STATUS_ACTIVE)
        )
        user_ids = list(result.scalars().all())

    synced = 0
    failed = 0
    imported = 0
    for user_id in user_ids:
        try:
            async with SessionFactory() as db:
                log = await run_sync(db, user_id)
            synced += 1
            imported += log.trades_imported or 0
        except Exception:
            failed += 1
            logger.exception("[binance-review-sync] user %s failed", user_id)

    summary = (
        f"[binance-review-sync] pass ok — users={len(user_ids)} "
        f"synced={synced} failed={failed} imported={imported}"
    )
    logger.info(summary)
    return summary
