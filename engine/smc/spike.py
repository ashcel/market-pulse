"""Vertical-spike + abnormal-volume + immediate-rejection detection (port of spike.ts).

A discovery/attention signal, NOT a trading decision. It answers "a pair just
lurched and got slapped back, look now", the same way discovery.py answers
"there is action here". Deliberately outside the trading engine: it touches no
decision/trigger semantics, no ENGINE_VERSION, and writes no forward-test
record, so its thresholds can be tuned freely without restarting the evidence
clock.

The pattern is a single-candle event on a short timeframe (15m by default):
one bar whose range is abnormally large vs its recent history, printed on
abnormally heavy volume, that closes with a dominant opposing wick — i.e. the
move was rejected within the bar ("immediate"). An up-spike rejected is an
exhaustion tell; a down-spike rejected is an absorption tell — but this module
never says long/short. It points attention; the token page's real engine gives
the verdict.

Detection uses only closed bars and a strictly *trailing* reference window
(the bars before the spike), so a spike confirmed at bar `i` never reads from
bars > `i` — replay-safe by construction, like fvg.py.
"""

from dataclasses import dataclass
from typing import Literal

from smc.types import Candle

SpikeDirection = Literal["up", "down"]


@dataclass(slots=True)
class SpikeEvent:
    # Direction of the spike that was rejected (up-spike = pushed up then faded).
    direction: SpikeDirection
    # The spike bar's open time.
    time: int
    # Bars from the end of the series (0 = latest closed bar). Callers gate recency.
    bars_ago: int
    # Bar range / trailing mean range — how vertical the move was.
    range_mult: float
    # Bar volume / trailing mean volume — how abnormal the participation was.
    volume_mult: float
    # Rejection wick as a fraction of the bar range (0..1) — how hard it was slapped back.
    rejection_fraction: float
    # Bar range as % of its mid price — the raw size of the lurch.
    range_pct: float
    # Non-directional attention line ("Sharp up-spike rejected on 3.4x volume").
    reason: str


# Trailing bars used as the "normal" reference for range and volume.
REF_WINDOW = 20
# Bar range must be at least this multiple of the trailing mean range.
SPIKE_RANGE_MULT = 2.5
# Bar volume must be at least this multiple of the trailing mean volume.
SPIKE_VOLUME_MULT = 3
# The rejection wick must be at least this fraction of the bar range.
REJECT_FRACTION = 0.6
# Only the last N closed bars count as "immediate" — a spike-and-reject three
# bars ago is history, not a current condition worth alerting on.
RECENCY_WINDOW = 2


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _evaluate_bar(candles: list[Candle], i: int) -> SpikeEvent | None:
    """Evaluates one candidate bar `i` against its trailing reference window.

    Returns the event if it clears all three gates, else None.
    """
    bar = candles[i]
    bar_range = bar.high - bar.low
    if bar_range <= 0:
        return None

    ref = candles[i - REF_WINDOW : i]
    mean_range = _mean([c.high - c.low for c in ref])
    mean_volume = _mean([c.volume for c in ref])
    if mean_range <= 0 or mean_volume <= 0:
        return None

    range_mult = bar_range / mean_range
    volume_mult = bar.volume / mean_volume
    if range_mult < SPIKE_RANGE_MULT or volume_mult < SPIKE_VOLUME_MULT:
        return None

    # Rejection is read from the dominant wick: an up-spike leaves its rejection
    # as the upper wick (pushed high, closed back down), a down-spike as the
    # lower wick. The larger wick names the direction that got rejected.
    body_high = max(bar.open, bar.close)
    body_low = min(bar.open, bar.close)
    upper_wick = bar.high - body_high
    lower_wick = body_low - bar.low
    direction: SpikeDirection = "up" if upper_wick >= lower_wick else "down"
    rejection_fraction = (upper_wick if direction == "up" else lower_wick) / bar_range
    if rejection_fraction < REJECT_FRACTION:
        return None

    mid = (bar.high + bar.low) / 2
    range_pct = (bar_range / mid) * 100 if mid > 0 else 0.0

    return SpikeEvent(
        direction=direction,
        time=bar.time,
        bars_ago=len(candles) - 1 - i,
        range_mult=range_mult,
        volume_mult=volume_mult,
        rejection_fraction=rejection_fraction,
        range_pct=range_pct,
        reason=f"Sharp {direction}-spike rejected on {volume_mult:.1f}× volume",  # noqa: RUF001 — multiplication sign matches the TS copy
    )


def detect_spike(candles: list[Candle]) -> SpikeEvent | None:
    """The most recent spike-and-reject within the recency window, or None.

    Scans newest-first and returns the first qualifying bar, so `bars_ago` is
    minimal. Needs at least `REF_WINDOW + 1` bars to have any trailing reference.
    """
    last = len(candles) - 1
    oldest = max(REF_WINDOW, last - RECENCY_WINDOW + 1)
    for i in range(last, oldest - 1, -1):
        event = _evaluate_bar(candles, i)
        if event is not None:
            return event
    return None
