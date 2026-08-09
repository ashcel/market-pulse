"""`app.patterns.universe.scan_universe` — the dynamic scan-universe gates
shared by the hourly REACCUMULATION pass and the live RALLY WATCHER scan.
Extracted verbatim from `worker/patterns_pass.py`; this test only pins the
gate/union behavior, not any network call.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from smc.discovery import Ticker24h
from smc.market import WORKER_UNIVERSE

from app.patterns import universe as universe_module


def _ticker(ticker: str, quote_volume24h: float, trades24h: float) -> Ticker24h:
    return Ticker24h(
        ticker=ticker,
        last_price=1.0,
        change_percent24h=0.0,
        high_price=1.0,
        low_price=1.0,
        weighted_avg_price=1.0,
        quote_volume24h=quote_volume24h,
        trades24h=trades24h,
    )


async def test_scan_universe_gates_by_volume_and_trades_and_unions_fixed_set():
    fixed_tickers = {asset.ticker for asset in WORKER_UNIVERSE}
    passes_both = _ticker("ZZZNEW", universe_module.SCAN_MIN_QUOTE_VOLUME + 1, universe_module.SCAN_MIN_TRADES + 1)
    fails_volume = _ticker("LOWVOL", universe_module.SCAN_MIN_QUOTE_VOLUME - 1, universe_module.SCAN_MIN_TRADES + 1)
    fails_trades = _ticker("LOWTRADES", universe_module.SCAN_MIN_QUOTE_VOLUME + 1, universe_module.SCAN_MIN_TRADES - 1)

    with patch.object(
        universe_module,
        "fetch_perp_ticker_24h_all",
        AsyncMock(return_value=[passes_both, fails_volume, fails_trades]),
    ):
        result = await universe_module.scan_universe()

    assert "ZZZNEW" in result
    assert "LOWVOL" not in result
    assert "LOWTRADES" not in result
    assert fixed_tickers.issubset(set(result))
    # Fixed set stays first — the curated baseline never depends on the sweep.
    assert result[: len(fixed_tickers)] == [asset.ticker for asset in WORKER_UNIVERSE]


async def test_scan_universe_degrades_to_fixed_set_on_empty_sweep():
    with patch.object(universe_module, "fetch_perp_ticker_24h_all", AsyncMock(return_value=[])):
        result = await universe_module.scan_universe()

    assert result == [asset.ticker for asset in WORKER_UNIVERSE]


async def test_scan_universe_caps_at_top_n():
    many = [
        _ticker(f"TICK{i}", universe_module.SCAN_MIN_QUOTE_VOLUME + i, universe_module.SCAN_MIN_TRADES + 1)
        for i in range(universe_module.SCAN_TOP_N + 50)
    ]
    with patch.object(universe_module, "fetch_perp_ticker_24h_all", AsyncMock(return_value=many)):
        result = await universe_module.scan_universe()

    fixed_count = len(WORKER_UNIVERSE)
    assert len(result) <= fixed_count + universe_module.SCAN_TOP_N
