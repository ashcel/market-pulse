"""Perp positioning context — funding + open interest (port of perp.ts, pure parts).

Funding tells you which side is crowded (squeeze risk); open interest tells
you whether a move has fresh money behind it. Spot has neither. The TS
module's fetchers are backend concerns; the engine interprets supplied metrics.
"""

from dataclasses import dataclass
from typing import Literal

# 8h funding rate, as a decimal. Binance's baseline is ~0.01% (0.0001). Beyond
# ~0.05% one side is clearly paying up to hold — crowded; ~0.1%+ is the kind of
# extreme that precedes a squeeze. Annualized ~ rate x 3 x 365.
_FUNDING_ELEVATED = 0.0005
_FUNDING_EXTREME = 0.001

# Open-interest change over the sampled window (24x1h). A couple of percent is
# noise; beyond it, positioning is meaningfully building or unwinding.
_OI_TREND_PCT = 2

FundingBias = Literal["neutral", "longs-crowded", "shorts-crowded"]
OiTrend = Literal["rising", "falling", "flat"]
PerpConviction = Literal["building", "unwinding", "neutral"]


@dataclass(slots=True)
class PerpMetrics:
    # Last settled 8h funding rate, as a decimal (0.0001 = 0.01%).
    funding_rate: float
    # Funding expressed as an annualized percentage, for readability.
    funding_annualized_pct: float
    # Epoch ms of the next funding settlement.
    next_funding_ms: int
    mark_price: float
    # Latest open-interest notional, in USDT.
    open_interest_value: float
    # Open-interest change over the sampled window, percent.
    oi_change_pct: float
    # Price change over the same window, percent — pairs with OI for conviction.
    price_change_pct: float


@dataclass(slots=True)
class PerpRead(PerpMetrics):
    funding_bias: FundingBias = "neutral"
    # Funding is beyond the extreme threshold — squeeze-prone.
    funding_extreme: bool = False
    oi_trend: OiTrend = "flat"
    conviction: PerpConviction = "neutral"
    # Compact one-line summary, e.g. "Longs crowded · OI building".
    label: str = ""
    # Plain-English read for the tooltip / verdict note.
    note: str = ""


def _funding_bias_of(rate: float) -> FundingBias:
    if rate > _FUNDING_ELEVATED:
        return "longs-crowded"
    if rate < -_FUNDING_ELEVATED:
        return "shorts-crowded"
    return "neutral"


def _oi_trend_of(change_pct: float) -> OiTrend:
    if change_pct > _OI_TREND_PCT:
        return "rising"
    if change_pct < -_OI_TREND_PCT:
        return "falling"
    return "flat"


def _funding_label(bias: FundingBias) -> str:
    if bias == "longs-crowded":
        return "Longs crowded"
    if bias == "shorts-crowded":
        return "Shorts crowded"
    return "Funding neutral"


def _format_apr(pct: float) -> str:
    sign = "+" if pct > 0 else ""
    return f"{sign}{pct:.0f}% APR"


def interpret_perp(metrics: PerpMetrics) -> PerpRead:
    """Turn raw funding + OI + price numbers into a directional positioning read."""
    funding_bias = _funding_bias_of(metrics.funding_rate)
    funding_extreme = abs(metrics.funding_rate) >= _FUNDING_EXTREME
    oi_trend = _oi_trend_of(metrics.oi_change_pct)
    conviction: PerpConviction = (
        "building" if oi_trend == "rising" else "unwinding" if oi_trend == "falling" else "neutral"
    )

    oi_word = (
        "building" if oi_trend == "rising" else "unwinding" if oi_trend == "falling" else "flat"
    )
    label = f"{_funding_label(funding_bias)} · OI {oi_word}"

    # OI + price direction says who is actually adding: rising OI with rising
    # price is fresh longs; rising OI with falling price is fresh shorts.
    price_up = metrics.price_change_pct >= 0
    if oi_trend == "rising":
        conviction_note = (
            "Open interest is rising into the move — fresh longs are adding, so the advance "
            "has real money behind it."
            if price_up
            else "Open interest is rising as price falls — fresh shorts are pressing, so the "
            "decline has conviction behind it."
        )
    elif oi_trend == "falling":
        conviction_note = (
            "Open interest is falling as price rises — this looks like short-covering more "
            "than fresh buying, so trust the follow-through less."
            if price_up
            else "Open interest is falling with price — positions are being closed out, so the "
            "move is losing fuel rather than building."
        )
    else:
        conviction_note = "Open interest is flat — no clear build-up or unwind in positioning."

    if funding_bias == "neutral":
        funding_note = (
            f"Funding is balanced ({_format_apr(metrics.funding_annualized_pct)}) — neither "
            "side is paying up to hold."
        )
    else:
        side = "Longs" if funding_bias == "longs-crowded" else "Shorts"
        risk = "a flush lower" if funding_bias == "longs-crowded" else "a squeeze higher"
        extreme_tag = " — an extreme reading" if funding_extreme else ""
        crowded_side = "long" if funding_bias == "longs-crowded" else "short"
        funding_note = (
            f"{side} are paying to stay in ({_format_apr(metrics.funding_annualized_pct)})"
            f"{extreme_tag}, so positioning is crowded {crowded_side} and vulnerable to {risk}."
        )

    return PerpRead(
        funding_rate=metrics.funding_rate,
        funding_annualized_pct=metrics.funding_annualized_pct,
        next_funding_ms=metrics.next_funding_ms,
        mark_price=metrics.mark_price,
        open_interest_value=metrics.open_interest_value,
        oi_change_pct=metrics.oi_change_pct,
        price_change_pct=metrics.price_change_pct,
        funding_bias=funding_bias,
        funding_extreme=funding_extreme,
        oi_trend=oi_trend,
        conviction=conviction,
        label=label,
        note=f"{funding_note} {conviction_note}",
    )
