"""Hourly REACCUMULATION / SECOND EXPANSION discovery pass.

Runs at most once an hour — much slower than the 5-min eval/settle cadence,
because the pattern is judged off 1H bars and re-running inside the same hour
would just re-derive the same read. For every symbol in the dynamic scan
universe (see `_scan_universe`) it evaluates `evaluate_reaccumulation` on perp
1H candles + OI history and, whenever the read clears the conviction floor
(score >= 40, either state), appends one `signal_events` row — append-only,
idempotent via the daily+state `dedup_key`.

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

from .binance import drop_unclosed_candle, fetch_klines, fetch_oi_history, fetch_perp_ticker_24h_all

logger = logging.getLogger("worker")

KLINE_LOOKBACK_LIMIT = 168
OI_LOOKBACK_LIMIT = 168
# How long a fired candidate stays "current" — a week is long relative to the
# 1H-bar pattern it describes.
EXPIRY_DAYS = 7
HORIZON = "swing"

SOURCE = "reaccumulation"
KIND = "reaccumulation"

# ── dynamic scan universe ────────────────────────────────────────────────────
# The pass must not be limited to the curated ~50-symbol WORKER_UNIVERSE: a
# reaccumulation candidate is exactly the kind of token that isn't on anyone's
# curated list yet. Gates mirror the spirit of `smc.discovery`'s liquidity/
# activity floors (perp, not spot), then rank survivors by 24h turnover and
# cap at SCAN_TOP_N to keep the ~2x fetch-call cost per pass bounded.
SCAN_MIN_QUOTE_VOLUME = 5_000_000
SCAN_MIN_TRADES = 10_000
SCAN_TOP_N = 120


async def _scan_universe() -> list[str]:
    """Fixed `WORKER_UNIVERSE` tickers (guaranteed baseline) unioned with the
    `SCAN_TOP_N` most liquid/active perp pairs from one full-market ticker
    sweep. Never persisted — re-derived fresh every pass, fixed-first so the
    curated set is never at the mercy of a bad ticker fetch (an empty/failed
    sweep just degrades to the fixed baseline, never an empty universe)."""
    fixed = [asset.ticker for asset in WORKER_UNIVERSE]
    tickers = await fetch_perp_ticker_24h_all()
    candidates = [
        row
        for row in tickers
        if row.quote_volume24h >= SCAN_MIN_QUOTE_VOLUME and row.trades24h >= SCAN_MIN_TRADES
    ]
    candidates.sort(key=lambda row: row.quote_volume24h, reverse=True)
    top = [row.ticker for row in candidates[:SCAN_TOP_N]]

    seen = set(fixed)
    universe = list(fixed)
    for ticker in top:
        if ticker not in seen:
            seen.add(ticker)
            universe.append(ticker)
    return universe


def _dedup_key(symbol: str, side: str, detected_at: datetime, state: str) -> str:
    # Extends the base `signal_events` dedup format (see `signals/models.py`)
    # with a trailing `|{state}` so a same-day ACCUMULATING -> SECOND_EXPANSION
    # transition writes a NEW row instead of being silently dropped as a
    # duplicate of the day's earlier ACCUMULATING read.
    return f"{SOURCE}|{symbol}|{side}|{HORIZON}|{detected_at.date().isoformat()}|{KIND}|{state}"


async def run_patterns_pass(db: AsyncSession) -> tuple[int, int, int]:
    """One sweep of the dynamic scan universe. Returns (written, evaluated,
    universe_size) for the heartbeat log — a network/parse failure on one
    symbol is caught and logged so it can never take down the rest of the
    sweep or the tick."""
    written = 0
    evaluated = 0

    universe = await _scan_universe()

    for symbol in universe:
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
            if read is None:
                continue

            conviction = conviction_for_score(read.score)
            if conviction is None:
                continue

            detected_at = datetime.fromtimestamp(read.evaluated_at, tz=UTC)
            features = {
                "score": read.score,
                "state": read.state,
                "evidence": read.evidence,
                "explanation": read.explanation,
                "oiAvailable": read.oi_available,
                "version": read.version,
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
                dedup_key=_dedup_key(symbol, read.direction, detected_at, read.state),
                status="shadow",
            )
            if inserted:
                written += 1
        except Exception:
            await db.rollback()
            logger.exception("[patterns] %s reaccumulation failed", symbol)

    return written, evaluated, len(universe)
