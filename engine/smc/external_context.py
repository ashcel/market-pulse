"""External market context — pure normalizers for the worker's breadth
ingestion (port of external-context.ts's ingester plane).

This is the news/context plane, NOT the signal engine: nothing here feeds
``EvaluateInput`` or any deterministic verdict path (ENGINE_VERSION
untouched). The assembled-context payload (/api/external-context) stays a
legacy-web read model over the same Postgres rows.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(slots=True)
class MarketContextSnapshotInput:
    """Normalized global-breadth poll (CoinGecko or CoinMarketCap) — one
    persisted snapshot."""

    total_mcap_usd: float
    btc_dominance: float
    eth_dominance: float | None
    mcap_change_24h_pct: float | None
    source: str


def _finite_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def normalize_coingecko_global(payload: object) -> MarketContextSnapshotInput | None:
    """Parse a CoinGecko ``/global`` response body into a snapshot input.
    Returns None when the payload doesn't carry the fields we need — a schema
    drift upstream must surface as an ingest error, never as a NaN row."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    total_mcap = data.get("total_market_cap")
    mcap = _finite_number(total_mcap.get("usd")) if isinstance(total_mcap, dict) else None
    pct = data.get("market_cap_percentage")
    btc = _finite_number(pct.get("btc")) if isinstance(pct, dict) else None
    if mcap is None or mcap <= 0 or btc is None or btc <= 0:
        return None
    eth = _finite_number(pct.get("eth")) if isinstance(pct, dict) else None
    change = _finite_number(data.get("market_cap_change_percentage_24h_usd"))
    return MarketContextSnapshotInput(
        total_mcap_usd=mcap,
        btc_dominance=btc,
        eth_dominance=eth,
        mcap_change_24h_pct=change,
        source="coingecko",
    )


def normalize_coinmarketcap_global(payload: object) -> MarketContextSnapshotInput | None:
    """Parse a CoinMarketCap ``/v1/global-metrics/quotes/latest`` response
    into the same snapshot shape. Available on the free Basic plan (1
    credit/call), so a working CMC key fully substitutes for CoinGecko as the
    breadth source."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    quote_wrap = data.get("quote")
    quote = quote_wrap.get("USD") if isinstance(quote_wrap, dict) else None
    mcap = _finite_number(quote.get("total_market_cap")) if isinstance(quote, dict) else None
    btc = _finite_number(data.get("btc_dominance"))
    if mcap is None or mcap <= 0 or btc is None or btc <= 0:
        return None
    eth = _finite_number(data.get("eth_dominance"))
    change = (
        _finite_number(quote.get("total_market_cap_yesterday_percentage_change"))
        if isinstance(quote, dict)
        else None
    )
    return MarketContextSnapshotInput(
        total_mcap_usd=mcap,
        btc_dominance=btc,
        eth_dominance=eth,
        mcap_change_24h_pct=change,
        source="coinmarketcap",
    )


def fear_greed_label(value: float) -> str:
    """The alternative.me index bands."""
    if value >= 75:
        return "Extreme Greed"
    if value >= 55:
        return "Greed"
    if value > 45:
        return "Neutral"
    if value > 25:
        return "Fear"
    return "Extreme Fear"
