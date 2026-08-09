"""Dynamic scan-universe derivation shared by every discovery pass that must
cover more than the curated `WORKER_UNIVERSE` (REACCUMULATION's hourly pass,
the live RALLY WATCHER scan). Extracted from `worker/patterns_pass.py`
verbatim — behavior is unchanged, only the call site moved.

Fixed `WORKER_UNIVERSE` tickers (guaranteed baseline) unioned with the
`SCAN_TOP_N` most liquid/active perp pairs from one full-market ticker sweep.
Never persisted — re-derived fresh every call, fixed-first so the curated set
is never at the mercy of a bad ticker fetch (an empty/failed sweep just
degrades to the fixed baseline, never an empty universe).
"""

from __future__ import annotations

from smc.market import WORKER_UNIVERSE

from app.worker.binance import fetch_perp_ticker_24h_all

SCAN_MIN_QUOTE_VOLUME = 5_000_000
SCAN_MIN_TRADES = 10_000
SCAN_TOP_N = 120


async def scan_universe() -> list[str]:
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


async def scan_universe_all() -> list[str]:
    """Every perp ticker Binance lists — no top-N cap, no trades gate. Only a
    zero-sanity floor: rows with no quote volume at all (delisting/thin-book
    noise) are dropped, everything else stays in. Used by the RALLY WATCHER
    cold-start scan ("semua coin di binance") — the detector itself returns
    None for non-rallies, so an oversized universe just costs fetch time, not
    false positives. Unlike `scan_universe()`, there is no fixed-baseline
    fallback: a failed/empty ticker sweep degrades to an empty universe (the
    caller's cache holds the last good result across that gap)."""
    tickers = await fetch_perp_ticker_24h_all()
    return [row.ticker for row in tickers if row.quote_volume24h > 0]
