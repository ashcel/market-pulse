"""CONTEXT ALIGNMENT — the one place slow context and fast events meet.

Everything else in the radar is deliberately ignorant of everything else: the
volume-anomaly detector knows nothing about market structure, the structure
engine knows nothing about volume, the micro-ChoCH detector knows nothing about
either. This module is the *only* combiner, and it combines the minimum
possible: a direction and a `MarketContext`.

That narrowness is what keeps it useful. It takes no metrics, no scores and no
event types, so it cannot quietly become a signal engine, and any detector
added later gets alignment for free by supplying a direction.

## What it answers

    4H bullish · 1H bullish · 3m bullish displacement   → aligned, high
    4H bullish · 1H bullish · 3m bearish displacement   → counter-trend
    4H ranging · 1H bearish                             → mixed context

A counter-trend classification is **not** a reversal call and an aligned one is
**not** an entry. Discover is an observation layer; the action layer that would
read these lives in the future, not here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from smc.market_context import DEFAULT_CONTEXT_CONFIG, ContextConfig, MarketContext

#: How strongly the event agrees with context.
AlignmentLevel = Literal["HIGH", "MODERATE", "COUNTER_TREND", "MIXED", "UNKNOWN"]
#: The coarse bucket a card labels the event with.
Classification = Literal["aligned", "counter_trend", "mixed", "unclassified"]


@dataclass(frozen=True, slots=True)
class Alignment:
    """How a directional event sits against its symbol's slow context."""

    level: AlignmentLevel
    classification: Classification
    # Weighted agreement of the context itself, 0-1 (0 when unknown).
    agreement: float
    # What the slow lane says: bullish | bearish | neutral | mixed | unknown.
    context_bias: str
    event_direction: str | None


UNKNOWN = Alignment(
    level="UNKNOWN",
    classification="unclassified",
    agreement=0.0,
    context_bias="unknown",
    event_direction=None,
)


def classify(
    event_direction: str | None,
    context: MarketContext | None,
    now: float,
    config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
) -> Alignment:
    """Classifies one directional event against cached higher-timeframe
    context. Pure, total, and never raises: missing or stale context degrades
    to UNKNOWN rather than inventing a read."""
    if context is None or context.is_stale(now, config):
        return UNKNOWN
    if event_direction is None:
        # A direction-less event (a volatility expansion, say) still reports
        # the context it happened in — it just cannot agree or disagree.
        return Alignment(
            level="UNKNOWN",
            classification="unclassified",
            agreement=context.agreement,
            context_bias=context.bias,
            event_direction=None,
        )
    if context.bias in ("mixed", "neutral"):
        # Unclear context stays unclear. Forcing a direction here would be
        # exactly the over-interpretation the layer is designed to avoid.
        return Alignment(
            level="MIXED",
            classification="mixed",
            agreement=context.agreement,
            context_bias=context.bias,
            event_direction=event_direction,
        )
    if context.bias == event_direction:
        level: AlignmentLevel = (
            "HIGH" if context.agreement >= config.high_agreement else "MODERATE"
        )
        return Alignment(
            level=level,
            classification="aligned",
            agreement=context.agreement,
            context_bias=context.bias,
            event_direction=event_direction,
        )
    return Alignment(
        level="COUNTER_TREND",
        classification="counter_trend",
        agreement=context.agreement,
        context_bias=context.bias,
        event_direction=event_direction,
    )
