"""Hourly REACCUMULATION / SECOND EXPANSION discovery pass.

Runs at most once an hour — much slower than the 5-min eval/settle cadence,
because the pattern is judged off 1H bars and re-running inside the same hour
would just re-derive the same read. For every WORKER_UNIVERSE symbol it
evaluates `evaluate_reaccumulation` on perp 1H candles + OI history and, on a
SECOND_EXPANSION fire, appends one `signal_events` row — append-only,
idempotent via the daily `dedup_key`, gated on conviction so sub-40 reads are
never written.

Deliberately outside the trading engine's version/provenance: this is a
discovery layer like `discovery.py`/`spike.py`, not a decision surface, so it
stamps its own `REACCUMULATION_VERSION` rather than `ENGINE_VERSION` and
writes `status='shadow'` — a new source with no track record yet.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from smc.market import WORKER_UNIVERSE
from smc.reaccumulation import (
    REACCUMULATION_VERSION,
    conviction_for_score,
    evaluate_reaccumulation,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.signals.repo import insert_signal

from .binance import drop_unclosed_candle, fetch_klines, fetch_oi_history

logger = logging.getLogger("worker")

KLINE_LOOKBACK_LIMIT = 168
OI_LOOKBACK_LIMIT = 168
# How long a fired candidate stays "current" — a week is long relative to the
# 1H-bar pattern it describes.
EXPIRY_DAYS = 7
HORIZON = "swing"

SOURCE = "reaccumulation"
KIND = "reaccumulation"


def _dedup_key(symbol: str, side: str, detected_at: datetime) -> str:
    return f"{SOURCE}|{symbol}|{side}|{HORIZON}|{detected_at.date().isoformat()}|{KIND}"


async def run_patterns_pass(db: AsyncSession) -> tuple[int, int]:
    """One sweep of WORKER_UNIVERSE. Returns (fired, evaluated) for the
    heartbeat log — a network/parse failure on one symbol is caught and
    logged so it can never take down the rest of the sweep or the tick."""
    fired = 0
    evaluated = 0

    for asset in WORKER_UNIVERSE:
        symbol = asset.ticker
        try:
            candles = drop_unclosed_candle(
                await fetch_klines(symbol, "1H", limit=KLINE_LOOKBACK_LIMIT, market="perp")
            )
            if not candles:
                continue
            # Best-effort: a failed OI pull degrades the read, never skips the symbol.
            oi_history = await fetch_oi_history(symbol, limit=OI_LOOKBACK_LIMIT)
            evaluated += 1

            read = evaluate_reaccumulation(candles, oi_history, symbol=symbol)
            if read is None or read.state != "SECOND_EXPANSION":
                continue

            conviction = conviction_for_score(read.score)
            if conviction is None:
                continue

            detected_at = datetime.fromtimestamp(read.evaluated_at, tz=UTC)
            features = {
                "score": read.score,
                "state": read.state,
                "evidence": read.evidence,
                "oiAvailable": read.oi_available,
                "impulseStartTime": read.impulse_start_time,
                "impulseEndTime": read.impulse_end_time,
                "impulseMagnitudePct": read.impulse_magnitude_pct,
                "retracementTime": read.retracement_time,
                "retracementFraction": read.retracement_fraction,
                "baseStartTime": read.base_start_time,
                "baseEndTime": read.base_end_time,
                "baseHigh": read.base_high,
                "baseLow": read.base_low,
                "breakoutPct": read.breakout_pct,
                "explanation": read.explanation,
            }
            inserted = await insert_signal(
                db,
                id=str(uuid.uuid4()),
                source=SOURCE,
                source_version=REACCUMULATION_VERSION,
                symbol=symbol,
                side=read.direction,
                horizon=HORIZON,
                kind=KIND,
                conviction=conviction,
                detected_at=detected_at,
                expires_at=detected_at + timedelta(days=EXPIRY_DAYS),
                features=features,
                dedup_key=_dedup_key(symbol, read.direction, detected_at),
                status="shadow",
            )
            if inserted:
                fired += 1
        except Exception:
            await db.rollback()
            logger.exception("[patterns] %s reaccumulation failed", symbol)

    return fired, evaluated
