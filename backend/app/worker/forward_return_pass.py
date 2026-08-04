"""Forward-return collection tick — the evidence plane's ground truth
(V1-T1, EDR 0024).

Runs hourly, not every 5 minutes: the measurement is anchored to closed 1H
bars, so a faster tick would re-derive the identical rows and land entirely on
ON CONFLICT DO NOTHING.

Two properties this pass is written to guarantee:

  1. **No lookahead.** The unclosed final candle is dropped before any
     computation (`drop_unclosed_candle`), and `compute_forward_returns` emits
     a row only when the bar it measures forward to already exists. A row can
     therefore never describe a future that has not happened.
  2. **Free re-runs.** Every pass re-fetches an overlapping window and
     recomputes measurements it already stored. That is deliberate: closed
     bars do not change, so recomputation is a consistency check that costs one
     conflicting insert.

Failure policy is per-symbol, matching the other passes: a dead feed for one
symbol is logged and skipped and can never take the tick — or the forward-test
worker sharing this process — down with it.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from smc.market import WORKER_UNIVERSE
from sqlalchemy.ext.asyncio import AsyncSession

from app.evidence import repo
from app.evidence.constants import BASE_INTERVAL, MAX_HORIZON_BARS
from app.evidence.forward_returns import compute_forward_returns
from app.worker.binance import (
    drop_unclosed_candle,
    fetch_klines,
    normalize_ticker,
    resolve_exchange_symbol,
)

logger = logging.getLogger("forward-return")

#: A single symbol may not hold the tick hostage.
PER_SYMBOL_TIMEOUT_S = 20.0

#: Bars fetched per symbol per pass. Binance's 1H limit is 1500; 500 covers a
#: cold start of roughly three weeks and leaves the whole longest horizon
#: (7d = 168 bars) inside one window, so the newest measurable anchor is always
#: reachable without paging.
KLINE_LIMIT = 500

#: Bars of overlap re-fetched beyond what is already stored. One full longest
#: horizon plus slack, so a bar that was unmeasurable last pass (its forward
#: bar had not printed) is picked up on the next one.
OVERLAP_BARS = MAX_HORIZON_BARS + 24


async def _collect_symbol(db: AsyncSession, ticker: str) -> int:
    """Fetch, compute and append one symbol's new forward returns. Returns the
    number of rows that were actually new."""
    symbol = normalize_ticker(ticker)
    exchange_symbol, _scale = resolve_exchange_symbol(ticker, "perp")

    latest = await repo.latest_observed_at(db, symbol)
    limit = KLINE_LIMIT
    if latest is not None:
        # Only the window since the last stored anchor, plus the overlap that
        # lets previously-unmeasurable bars complete.
        elapsed_bars = int((datetime.now(UTC) - latest) / timedelta(hours=1))
        limit = min(KLINE_LIMIT, max(elapsed_bars + OVERLAP_BARS, MAX_HORIZON_BARS + 2))

    candles = await fetch_klines(ticker, BASE_INTERVAL, limit=limit, market="perp")
    candles = drop_unclosed_candle(candles)
    if len(candles) <= MAX_HORIZON_BARS:
        logger.info(
            "[forward-return] %s skipped — %d closed bars, need > %d",
            symbol,
            len(candles),
            MAX_HORIZON_BARS,
        )
        return 0

    rows = compute_forward_returns(symbol, candles)
    inserted = await repo.insert_forward_returns(db, rows)
    logger.debug(
        "[forward-return] %s (%s) computed=%d new=%d",
        symbol,
        exchange_symbol,
        len(rows),
        inserted,
    )
    return inserted


async def run_forward_return_pass(db: AsyncSession) -> str:
    """One pass over the tracked universe. Always registered — this plane
    measures, it never decides, so there is nothing to gate."""
    total_new = 0
    failed = 0

    for asset in WORKER_UNIVERSE:
        try:
            total_new += await asyncio.wait_for(
                _collect_symbol(db, asset.ticker), timeout=PER_SYMBOL_TIMEOUT_S
            )
        except TimeoutError:
            failed += 1
            logger.warning("[forward-return] %s timed out", asset.ticker)
        except Exception:
            failed += 1
            logger.exception("[forward-return] %s failed", asset.ticker)

    summary = (
        f"[forward-return] pass ok — symbols={len(WORKER_UNIVERSE)} "
        f"new_rows={total_new} failed={failed}"
    )
    logger.info(summary)
    return summary
