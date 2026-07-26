import logging

from sqlalchemy import select

from app.binance_review.config import binance_review_settings
from app.binance_review.models import BinanceTrade
from app.database import SessionFactory
from app.review.forensics_service import compute_forensics_for_user

logger = logging.getLogger("worker")


async def run_forensics_pass() -> str:
    async with SessionFactory() as db:
        user_ids = list((await db.scalars(select(BinanceTrade.user_id).distinct())).all())

    written = 0
    failed = 0
    for user_id in user_ids:
        try:
            async with SessionFactory() as db:
                written += await compute_forensics_for_user(
                    db, user_id, testnet=binance_review_settings.TESTNET
                )
        except Exception:
            failed += 1
            logger.exception("[forensics] user %s failed", user_id)
    summary = f"[forensics] users={len(user_ids)} written={written} failed={failed}"
    logger.info(summary)
    return summary
