"""Thresholds and Indonesian labels for the derivatives intelligence plane.

Every number here is a *classification* threshold, not engine decision
semantics: nothing in this package writes a forward-test record, so tuning a
band does not restart the evidence clock (`engine/smc/version.py` untouched —
CLAUDE.md "Engine change discipline").
"""

from typing import Final

# --- sampling ------------------------------------------------------------

# The worker ticks every 5 minutes and floors each snapshot onto the 5-minute
# grid, so a "slot" is 300 s. Retrying a tick inside the same slot re-derives
# the same primary key and is dropped by ON CONFLICT DO NOTHING.
SNAPSHOT_INTERVAL_S: Final[int] = 300

# Windows offered for OI/price deltas (seconds).
DELTA_WINDOWS_S: Final[dict[str, int]] = {
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "24h": 86400,
}

# Windows offered to the sparkline endpoint (seconds of lookback).
HISTORY_WINDOWS_S: Final[dict[str, int]] = {
    "5m": 300,
    "1h": 3600,
    "4h": 14400,
    "24h": 86400,
}

HISTORY_METRICS: Final[tuple[str, ...]] = (
    "momentum",
    "oi",
    "funding",
    "buyer_aggression",
    "squeeze_long",
    "squeeze_short",
)


# A delta is only reported if a stored snapshot exists near the window's start.
# Half the window, floored at two snapshot slots: tight enough that a "1h
# delta" is not silently a 40-minute delta, loose enough to survive one missed
# tick. A missing sample yields None — never a fabricated number.
def delta_tolerance_s(window_s: int) -> float:
    return max(window_s * 0.5, SNAPSHOT_INTERVAL_S * 2)


# --- normalisation bounds ------------------------------------------------

# Funding rate that maps to a fully one-sided reading. 0.05% per 8h is the
# level at which the carry itself becomes the trade on Binance USDⓈ-M.
FUNDING_BOUND: Final[float] = 0.0005

# |ln(ratio)| that maps to a fully one-sided long/short book. ln(2) ≈ 0.69, so
# 0.7 means "twice as many longs as shorts" pins the scale.
LOG_RATIO_BOUND: Final[float] = 0.7

# (mark - index) / index that maps to a fully one-sided basis. 0.1%.
PREMIUM_BOUND: Final[float] = 0.001

# Below this absolute percent move, price/OI count as flat rather than as a
# direction. Without it every rounding wiggle would classify an expansion.
EXPANSION_EPS_PCT: Final[float] = 0.05

# --- composite weights ---------------------------------------------------

# Momentum Score. Weights are renormalised over the components that actually
# have data, so a missing feed lowers confidence, never the score's meaning.
MOMENTUM_WEIGHTS: Final[dict[str, float]] = {
    "oi_expansion": 0.40,
    "buyer_aggression": 0.35,
    "funding": 0.15,
    "basis": 0.10,
}

# Crowding Score, same renormalisation rule.
CROWDING_WEIGHTS: Final[dict[str, float]] = {
    "funding": 0.40,
    "long_short_ratio": 0.30,
    "top_trader": 0.30,
}

# Momentum contribution of each OI-expansion class (0-100).
EXPANSION_MOMENTUM: Final[dict[str, float]] = {
    "bullish_expansion": 100.0,
    "short_covering": 60.0,
    "neutral": 50.0,
    "long_capitulation": 40.0,
    "bearish_expansion": 0.0,
}

# --- bands ---------------------------------------------------------------

CROWDING_BEARISH_MAX: Final[float] = 30.0
CROWDING_BULLISH_MIN: Final[float] = 70.0

AGGRESSION_STRONG: Final[float] = 0.65
AGGRESSION_WEAK: Final[float] = 0.35

# Regime rule thresholds.
REGIME_TREND_PRICE_EPS_PCT: Final[float] = 1.0
REGIME_MOMENTUM_STRONG_BULL: Final[float] = 70.0
REGIME_MOMENTUM_WEAK_BULL: Final[float] = 55.0
REGIME_MOMENTUM_STRONG_BEAR: Final[float] = 30.0
REGIME_MOMENTUM_WEAK_BEAR: Final[float] = 45.0
REGIME_OI_RISING_PCT: Final[float] = 1.0

# --- Indonesian labels ---------------------------------------------------

EXPANSION_LABELS: Final[dict[str, str]] = {
    "bullish_expansion": "Bullish Expansion",
    "short_covering": "Short Covering",
    "bearish_expansion": "Bearish Expansion",
    "long_capitulation": "Long Capitulation",
    "neutral": "Datar",
}

CROWDING_LABELS: Final[dict[str, str]] = {
    "bearish_crowded": "Short padat",
    "balanced": "Seimbang",
    "bullish_crowded": "Long padat",
    "unknown": "Belum cukup data",
}

REGIME_LABELS: Final[dict[str, str]] = {
    "strong_bull_trend": "Tren Naik Kuat",
    "weak_bull_trend": "Tren Naik Lemah",
    "strong_bear_trend": "Tren Turun Kuat",
    "weak_bear_trend": "Tren Turun Lemah",
    "short_squeeze": "Short Squeeze",
    "long_squeeze": "Long Squeeze",
    "distribution": "Distribusi",
    "accumulation": "Akumulasi",
    "neutral": "Netral",
}
