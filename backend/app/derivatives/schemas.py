"""Response contracts for the derivatives plane.

The client renders these fields and computes nothing: `derived`, `scores`,
`regime` and `intelligence` all arrive finished. Any number the UI shows has
exactly one implementation, here.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

OiExpansion = Literal[
    "bullish_expansion",
    "short_covering",
    "bearish_expansion",
    "long_capitulation",
    "neutral",
]

CrowdingBand = Literal["bearish_crowded", "balanced", "bullish_crowded", "unknown"]

MarketRegime = Literal[
    "strong_bull_trend",
    "weak_bull_trend",
    "strong_bear_trend",
    "weak_bear_trend",
    "short_squeeze",
    "long_squeeze",
    "distribution",
    "accumulation",
    "neutral",
]

HistoryMetric = Literal[
    "momentum", "oi", "funding", "buyer_aggression", "squeeze_long", "squeeze_short"
]
HistoryWindow = Literal["5m", "1h", "4h", "24h"]


class DerivativesRaw(BaseModel):
    """The latest stored snapshot, verbatim. Present so the interpretation
    above it is auditable — not so the UI can re-derive anything from it."""

    model_config = ConfigDict(from_attributes=True)

    symbol: str
    timestamp: datetime
    open_interest: float | None
    open_interest_usd: float | None
    funding_rate: float | None
    long_short_ratio: float | None
    top_trader_accounts_ratio: float | None
    top_trader_positions_ratio: float | None
    taker_buy_volume: float | None
    taker_sell_volume: float | None
    basis: float | None
    premium: float | None
    oi_marketcap_ratio: float | None
    price: float | None


class FundingTrend(BaseModel):
    current: float | None
    delta_15m: float | None
    delta_1h: float | None
    # Percentile rank (0-100) of the current rate inside the last 24h of
    # stored rates. None until there are at least two distinct samples.
    percentile_24h: float | None


class SqueezeScores(BaseModel):
    """RELATIVE pressure only — explicitly NOT a prediction. `long` is how
    much more exposed crowded longs are than crowded shorts right now, on a
    0-100 scale whose sum is capped at 100."""

    long: float
    short: float


class Scores(BaseModel):
    momentum: float | None
    crowding: float | None
    squeeze: SqueezeScores


class Derived(BaseModel):
    # Keyed by window label: "5m" | "15m" | "1h" | "24h". Percent change.
    oi_delta: dict[str, float | None]
    price_delta: dict[str, float | None]
    funding_trend: FundingTrend
    # taker_buy / (taker_buy + taker_sell), 0-1.
    buyer_aggression: float | None
    oi_expansion: OiExpansion
    crowding_score: float | None
    crowding_band: CrowdingBand
    momentum_score: float | None
    squeeze: SqueezeScores
    # How much history the derivation actually had. A reader must be able to
    # tell "balanced" from "we only have twenty minutes of data".
    sample_count: int
    history_span_s: float


class Intelligence(BaseModel):
    """Deterministic, rule-based, Indonesian. No LLM anywhere on this path."""

    summary: str
    regime_label: str
    crowding_label: str
    expansion_label: str
    funding_label: str
    oi_label: str
    aggression_label: str
    squeeze_label: str


class DerivativesIntelligence(BaseModel):
    raw: DerivativesRaw
    derived: Derived
    regime: MarketRegime
    intelligence: Intelligence
    scores: Scores


class SparkPoint(BaseModel):
    # Epoch seconds — matches the frontend `SparkPoint` the MiniChart eats.
    t: int
    v: float


class DerivativesHistory(BaseModel):
    symbol: str
    metric: HistoryMetric
    window: HistoryWindow
    points: list[SparkPoint]


# --- cross-symbol summary --------------------------------------------------
#
# Same rule as everything above: labels arrive finished (`regime_label`,
# `squeeze_label`), never a bare enum the client would have to re-map.


class SummaryMomentumEntry(BaseModel):
    symbol: str
    momentum: float
    regime: MarketRegime
    regime_label: str


class SummarySqueezeEntry(BaseModel):
    symbol: str
    squeeze: SqueezeScores
    dominant_side: Literal["long", "short"]
    squeeze_label: str


class SummaryOiEntry(BaseModel):
    symbol: str
    oi_delta_pct: float
    regime: MarketRegime
    regime_label: str


class RegimeCount(BaseModel):
    regime: MarketRegime
    regime_label: str
    count: int


class DerivativesSummary(BaseModel):
    top_momentum: list[SummaryMomentumEntry]
    top_squeeze: list[SummarySqueezeEntry]
    top_oi_gainers: list[SummaryOiEntry]
    top_oi_losers: list[SummaryOiEntry]
    regime_distribution: list[RegimeCount]
    symbols_covered: int
