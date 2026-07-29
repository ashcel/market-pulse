"""Stamp market context while Binance reports a position open — never after.

The rule (docs/forensics-definitions.md §8.1) has no exceptions: context is
read from the live read models at the instant a position is first observed and
is never backfilled, recomputed, or reconstructed. Nothing in this module
touches `BinanceTrade` — that table holds *closed* trades, and building a stamp
from one would be a claim about the past assembled later.

A position seen on a later tick belongs to the same episode and adds no row;
only `last_seen_at` moves. Corrections insert a new row with `supersedes_id`.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from smc.market import WORKER_UNIVERSE
from smc.sessions import SESSION_WINDOWS
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.binance_review.config import binance_review_settings
from app.binance_review.context_models import TradeContext
from app.binance_review.models import BinanceReviewKey
from app.events.impact import IMPACT_SCORE_VERSION
from app.events.service import (
    list_economic_events,
    list_token_events,
    list_upcoming_catalysts,
)
from app.execution.binance_client import BinanceExecClient
from app.execution.exec_key_crypto import decrypt
from app.forward_test.models import EvalLog
from app.review.forensics import FORENSICS_DEFINITIONS_VERSION
from app.worker.binance import bare_ticker

logger = logging.getLogger("worker")

TICK = timedelta(minutes=5)
OBSERVATION_LAG_BOUND_SECONDS = int(TICK.total_seconds())
#: An episode survives one missed tick before the next sighting counts as new.
EPISODE_GAP = 2 * TICK
#: Three worker ticks. Beyond this the engine read is not the read at open.
MAX_EVAL_STALENESS_SECONDS = 900.0

CATALYST_LOOKAHEAD = timedelta(days=7)
NEWS_LOOKBACK = timedelta(hours=48)
ECONOMIC_LOOKAHEAD = timedelta(hours=24)

_UNIVERSE_TICKERS = frozenset(asset.ticker.upper() for asset in WORKER_UNIVERSE)


def session_of(moment: datetime) -> str:
    """The engine's session grid (§8.3) — 21:00-24:00 UTC is a real category."""
    hour = moment.astimezone(UTC).hour
    for window in SESSION_WINDOWS:
        if window.start_hour <= hour < window.end_hour:
            return window.session
    return "off_hours"


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment


async def read_engine_context(
    db: AsyncSession, ticker: str, stamped_at: datetime
) -> dict[str, Any]:
    """The engine's current read for this symbol, or an explicit absence."""
    absent = {
        "regime": None,
        "verdicts_at_open": None,
        "eval_log_id": None,
        "eval_evaluated_at": None,
        "eval_staleness_seconds": None,
        "engine_version": None,
        "config_hash": None,
        "git_sha": None,
    }
    if ticker not in _UNIVERSE_TICKERS:
        return {**absent, "verdict_source": "not_in_universe"}
    rows = list(
        (
            await db.scalars(
                select(EvalLog)
                .where(EvalLog.symbol == ticker, EvalLog.market == "perp")
                .order_by(EvalLog.evaluated_at.desc())
                .limit(20)
            )
        ).all()
    )
    if not rows:
        return {**absent, "verdict_source": "stale"}
    newest_at = _aware(rows[0].evaluated_at)
    assert newest_at is not None
    staleness = (stamped_at - newest_at).total_seconds()
    if staleness > MAX_EVAL_STALENESS_SECONDS:
        return {
            **absent,
            "verdict_source": "stale",
            "eval_evaluated_at": newest_at,
            "eval_staleness_seconds": staleness,
        }
    same_tick = [row for row in rows if _aware(row.evaluated_at) == newest_at]
    return {
        "regime": rows[0].regime,
        "verdicts_at_open": [
            {
                "intent": row.intent,
                "verdict": row.verdict,
                "direction": row.direction,
                "setup_type": row.setup_type,
                "timeframe": row.timeframe,
                "confidence": row.confidence,
                "no_trade_reasons": row.no_trade_reasons,
            }
            for row in same_tick
        ],
        "verdict_source": "live",
        "eval_log_id": rows[0].id,
        "eval_evaluated_at": newest_at,
        "eval_staleness_seconds": staleness,
        "engine_version": rows[0].engine_version,
        "config_hash": rows[0].config_hash,
        "git_sha": rows[0].git_sha,
    }


def _event_row(category: str, event: Any, occurs_at: datetime) -> dict[str, Any]:
    """Serialize the event fact **plus** the impact as scored at this instant.

    `score_event` weights proximity, so re-scoring the same event tomorrow
    returns a different number; a reference would silently mutate history.
    """
    return {
        "id": event.id,
        "category": category,
        "kind": getattr(event, "kind", None) or getattr(event, "source_impact", None),
        "title": event.title,
        "occurs_at": occurs_at.isoformat(),
        "source": event.source,
        "impact": event.impact,
        "direction": event.direction,
        "impact_score": event.impact_score,
        "impact_capped": event.impact_capped,
        "impact_version": event.impact_version,
    }


async def read_catalysts(
    db: AsyncSession, ticker: str, stamped_at: datetime
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    events = [
        _event_row("catalyst", row, row.occurs_at)
        for row in await list_upcoming_catalysts(db, ticker, stamped_at + CATALYST_LOOKAHEAD)
    ]
    events += [
        _event_row("token_event", row, row.published_at)
        for row in await list_token_events(db, ticker)
        if _aware(row.published_at) and _aware(row.published_at) >= stamped_at - NEWS_LOOKBACK
    ]
    events += [
        _event_row("economic", row, row.occurs_at)
        for row in await list_economic_events(
            db, stamped_at + ECONOMIC_LOOKAHEAD, min_impact="high"
        )
    ]
    if not events:
        return [], None
    top = max(events, key=lambda event: event["impact_score"])
    return events, {
        "id": top["id"],
        "impact_score": top["impact_score"],
        "direction": top["direction"],
    }


async def _open_episode(
    db: AsyncSession, user_id: str, symbol: str, side: str, observed_at: datetime
) -> TradeContext | None:
    return await db.scalar(
        select(TradeContext)
        .where(
            TradeContext.user_id == user_id,
            TradeContext.symbol == symbol,
            TradeContext.side == side,
            TradeContext.last_seen_at >= observed_at - EPISODE_GAP,
        )
        .order_by(TradeContext.first_seen_at.desc())
        .limit(1)
    )


async def stamp_position(
    db: AsyncSession,
    user_id: str,
    symbol: str,
    side: str,
    observed_at: datetime,
    observation_source: str = "position_poll",
) -> TradeContext | None:
    """Write the episode's one context row, or extend the episode already open."""
    episode = await _open_episode(db, user_id, symbol, side, observed_at)
    if episode is not None:
        episode.last_seen_at = observed_at  # bookkeeping, not a context field
        return None
    ticker = bare_ticker(symbol)
    engine = await read_engine_context(db, ticker, observed_at)
    catalysts, catalyst_top = await read_catalysts(db, ticker, observed_at)
    row = TradeContext(
        user_id=user_id,
        symbol=symbol,
        side=side,
        first_seen_at=observed_at,
        last_seen_at=observed_at,
        stamped_at=observed_at,
        observation_source=observation_source,
        observation_lag_bound_seconds=(
            0 if observation_source == "execution_record" else OBSERVATION_LAG_BOUND_SECONDS
        ),
        session=session_of(observed_at),
        catalysts=catalysts,
        catalyst_top=catalyst_top,
        forensics_version=FORENSICS_DEFINITIONS_VERSION,
        impact_score_version=IMPACT_SCORE_VERSION,
        **engine,
    )
    db.add(row)
    return row


async def run_context_stamper_pass(db: AsyncSession, now: datetime | None = None) -> int:
    """One 5-minute pass over every review key's live positions."""
    observed_at = now or datetime.now(UTC)
    keys = list((await db.scalars(select(BinanceReviewKey))).all())

    written = 0
    for key in keys:
        try:
            client = BinanceExecClient(
                key.api_key, decrypt(key.encrypted_secret), binance_review_settings.TESTNET
            )
            for position in await client.get_positions():
                amount = float(position.get("positionAmt") or 0)
                if amount == 0:
                    continue
                row = await stamp_position(
                    db,
                    key.user_id,
                    str(position["symbol"]),
                    "LONG" if amount > 0 else "SHORT",
                    observed_at,
                )
                written += row is not None
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("[context-stamper] user %s failed", key.user_id)
    return written
