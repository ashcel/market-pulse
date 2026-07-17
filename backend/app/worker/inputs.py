"""Input assembly for evaluate_symbol — the WS1 parity contract, in Python.

Builds the non-worker-specific half of an evaluate_symbol call for one
symbol: per-timeframe evals/zones (the alignment computation) and session
levels — the exact reads the legacy token page resolved server-side, so the
worker provably grades the same inputs a user would see, not a lookalike
reimplementation. combo_stats/holds/now_ms stay the caller's job.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from smc.analysis import compute_pivots
from smc.crypto_config import CRYPTO_RISK_SETTINGS
from smc.intent import ZonesByTimeframe
from smc.mock_candles import TOKEN_TIMEFRAMES, TokenTimeframe, generate_mock_candles
from smc.perp import PerpRead
from smc.quant import SignalEvaluation, evaluate_signal
from smc.sessions import SESSION_LEVELS_CANDLE_LIMIT, SessionLevel, compute_session_levels
from smc.types import Candle, MarketType
from smc.zones import SD_ZONE_TIMEFRAMES, compute_base_zones

from .binance import (
    drop_unclosed_candle,
    fetch_klines,
    fetch_perp_context,
    fetch_price,
    normalize_ticker,
)


@dataclass(slots=True)
class AssembledInputs:
    evals_by_timeframe: dict[TokenTimeframe, SignalEvaluation] = field(default_factory=dict)
    zones_by_timeframe: ZonesByTimeframe = field(default_factory=dict)
    session_levels: list[SessionLevel] = field(default_factory=list)
    # Real funding/OI context in perp mode; None on spot (which has neither).
    perp: PerpRead | None = None


async def _fetch_timeframe(
    ticker: str, timeframe: TokenTimeframe, market: MarketType
) -> tuple[TokenTimeframe, list[Candle]]:
    candles = await fetch_klines(ticker, timeframe, limit=200, market=market)
    closed = drop_unclosed_candle(candles)
    # Deterministic demo fallback, exactly as the legacy alignment does — a
    # feed outage degrades to the mock read instead of skipping the symbol.
    return timeframe, closed if closed else generate_mock_candles(ticker, timeframe)


async def assemble_evaluate_inputs(
    symbol: str, market: MarketType
) -> AssembledInputs | None:
    ticker = normalize_ticker(symbol)
    if not ticker:
        return None

    series, live_price, session_candles, perp = await asyncio.gather(
        asyncio.gather(*(_fetch_timeframe(ticker, tf, market) for tf in TOKEN_TIMEFRAMES)),
        fetch_price(ticker, market),
        fetch_klines(ticker, "1H", limit=SESSION_LEVELS_CANDLE_LIMIT, market=market),
        # Same source the token page's perp mode reads; None on any failure —
        # the verdict must stand without it, exactly as the UI behaves.
        fetch_perp_context(ticker) if market == "perp" else asyncio.sleep(0, result=None),
    )

    assembled = AssembledInputs(perp=perp)
    for timeframe, candles in series:
        zones = compute_base_zones(candles) if timeframe in SD_ZONE_TIMEFRAMES else []
        evaluation = evaluate_signal(
            ticker,
            candles,
            compute_pivots(candles),
            CRYPTO_RISK_SETTINGS,
            None,
            live_price,
            zones,
        )
        assembled.evals_by_timeframe[timeframe] = evaluation
        assembled.zones_by_timeframe[timeframe] = zones

    if not assembled.evals_by_timeframe:
        return None

    if session_candles:
        assembled.session_levels = compute_session_levels(drop_unclosed_candle(session_candles))
    return assembled
