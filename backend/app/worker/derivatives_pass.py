"""Derivatives collection tick — one `derivatives_snapshot` row per universe
symbol, every 5 minutes.

Shape borrowed from the other passes in this package: the flag is checked
*inside* the pass rather than at cron registration, so flipping
`DERIVATIVES_ENABLED=1` takes effect on the next tick with no worker restart
(and flipping it back is the one-line rollback, plan §1 rule 3).

Failure policy: per-symbol. One symbol's dead feed is logged and skipped; it
can never take the tick — or the forward-test worker sharing this process —
down with it.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from smc.market import WORKER_UNIVERSE
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.derivatives import repo
from app.derivatives.binance import (
    canonical_symbol,
    fetch_market_caps,
    fetch_open_interest_hist,
    fetch_snapshot,
    floor_to_slot,
)
from app.derivatives.constants import SNAPSHOT_INTERVAL_S
from app.worker.binance import resolve_exchange_symbol

logger = logging.getLogger("derivatives")

# A single symbol may not hold the tick hostage. Seven sequential public
# endpoints comfortably fit well inside this.
PER_SYMBOL_TIMEOUT_S = 20.0

# Cold start: a symbol with fewer than this many rows in the last day cannot
# answer a 24h OI delta, so its OI history is backfilled once from Binance.
COLD_START_MIN_ROWS = 2
# 288 five-minute buckets = 24 hours, which is exactly the longest delta window.
BACKFILL_LIMIT = 288


async def _backfill_oi_history(db: AsyncSession, ticker: str, slot: datetime) -> int:
    """Seed 24h of OI-only rows so the 24h delta answers on day one.

    These rows carry ONLY `open_interest` / `open_interest_usd` — every other
    column stays NULL, because Binance publishes no history for them and a
    fabricated funding rate would poison the percentile the moment real rows
    arrive. The current slot is excluded so the live snapshot (which has all
    the columns) is never pre-empted by a partial row under
    ON CONFLICT DO NOTHING.
    """
    pair, price_scale = resolve_exchange_symbol(ticker, "perp")
    history = await fetch_open_interest_hist(pair, period="5m", limit=BACKFILL_LIMIT)
    symbol = canonical_symbol(ticker)

    rows: list[dict[str, object]] = []
    for entry in history:
        timestamp = datetime.fromtimestamp(entry["timestamp"] / 1000, tz=UTC)
        bucket = floor_to_slot(timestamp, SNAPSHOT_INTERVAL_S)
        if bucket >= slot:
            continue
        open_interest = entry.get("open_interest")
        rows.append(
            {
                "symbol": symbol,
                "timestamp": bucket,
                "open_interest": None if open_interest is None else open_interest * price_scale,
                "open_interest_usd": entry.get("open_interest_usd"),
            }
        )
    if not rows:
        return 0
    return await repo.insert_snapshots(db, rows)


async def run_derivatives_pass(db: AsyncSession, *, now: datetime | None = None) -> str:
    """Collect one snapshot per universe symbol. Returns the tick summary."""
    if not settings.DERIVATIVES_ENABLED:
        return "[derivatives] disabled (DERIVATIVES_ENABLED=0)"

    slot = floor_to_slot(now or datetime.now(UTC), SNAPSHOT_INTERVAL_S)
    tickers = [asset.ticker for asset in WORKER_UNIVERSE]

    # One batched, hourly-cached CoinGecko call for the whole universe. A
    # miss simply leaves `oi_marketcap_ratio` NULL for that symbol.
    try:
        market_caps = await fetch_market_caps(tickers)
    except Exception:
        logger.exception("[derivatives] market cap fetch failed")
        market_caps = {}

    rows: list[dict[str, object]] = []
    failed: list[str] = []
    backfilled = 0

    for ticker in tickers:
        try:
            symbol = canonical_symbol(ticker)
            if await repo.count_since(db, symbol, slot - timedelta(days=1)) < COLD_START_MIN_ROWS:
                backfilled += await _backfill_oi_history(db, ticker, slot)

            snapshot = await asyncio.wait_for(
                fetch_snapshot(ticker, timestamp=slot, market_cap=market_caps.get(ticker)),
                timeout=PER_SYMBOL_TIMEOUT_S,
            )
        except TimeoutError:
            logger.warning("[derivatives] %s timed out after %.0fs", ticker, PER_SYMBOL_TIMEOUT_S)
            failed.append(ticker)
            continue
        except Exception:
            # Broad on purpose: this loop's contract is that no single symbol
            # can end the tick. The traceback is logged, not swallowed.
            logger.exception("[derivatives] %s failed", ticker)
            failed.append(ticker)
            continue

        if snapshot.open_interest is None and snapshot.price is None:
            # Nothing usable arrived. Writing an all-NULL row would only add a
            # sample count that means nothing.
            failed.append(ticker)
            continue

        rows.append(
            {
                "symbol": snapshot.symbol,
                "timestamp": snapshot.timestamp,
                "open_interest": snapshot.open_interest,
                "open_interest_usd": snapshot.open_interest_usd,
                "funding_rate": snapshot.funding_rate,
                "long_short_ratio": snapshot.long_short_ratio,
                "top_trader_accounts_ratio": snapshot.top_trader_accounts_ratio,
                "top_trader_positions_ratio": snapshot.top_trader_positions_ratio,
                "taker_buy_volume": snapshot.taker_buy_volume,
                "taker_sell_volume": snapshot.taker_sell_volume,
                "basis": snapshot.basis,
                "premium": snapshot.premium,
                "oi_marketcap_ratio": snapshot.oi_marketcap_ratio,
                "price": snapshot.price,
            }
        )

    written = 0
    if rows:
        try:
            written = await repo.insert_snapshots(db, rows)
        except Exception:
            logger.exception("[derivatives] insert failed")
            await db.rollback()
            return f"[derivatives] error slot={slot.isoformat()} collected={len(rows)}"

    return (
        f"[derivatives] slot={slot.isoformat()} written={written} "
        f"collected={len(rows)} backfilled={backfilled} failed={len(failed)}"
    )
