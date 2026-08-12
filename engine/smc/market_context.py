"""MARKET CONTEXT — slow, cached higher-timeframe read of where a symbol is.

The radar's fast lane (`momentum.py` / `momentum_events.py`) answers *what just
happened* on 1m/3m/5m. This module answers the other question — *where are we* —
from 4H/1H/15m/5m closed candles, and it deliberately moves at a different
speed:

    4H / 1H     slow market context  (macro regime, directional bias)
    15m / 5m    structural context   (intermediate + short-term structure)
    3m / 1m     not here at all      (that is the event layer's job)

## Why this is a separate module

Keeping context independent is the point (see the architecture note in
`app.momentum`): the volume-anomaly detector knows nothing about structure, the
structure read knows nothing about volume, and `context_alignment` is the only
place the two meet. That is what keeps each piece explainable and separately
researchable.

## Stability

A context badge that flickers is worse than no badge. Two mechanisms keep it
still:

* **Cadence** — reads are recomputed from closed candles on slow timers by the
  caller (`app.momentum.context_cache`), never on a realtime tick.
* **Flip confirmation** — the aggregate bias only changes after the new reading
  has been produced `flip_confirmations` times in a row, unless the new reading
  is decisive (`flip_override_agreement`). `bias_since` records when the
  displayed bias last actually changed, so the UI can show how settled it is.

Everything here is pure: candles in, context out, no I/O and no clock reads
beyond the `now` the caller passes.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal

from smc.analysis import compute_pivots
from smc.structure import StructureTrend, compute_market_structure, structure_lean
from smc.structure_map import StructureMap, from_structure
from smc.types import Candle

MARKET_CONTEXT_VERSION = "1.0.0"

#: Directional read of one timeframe. Never "mixed" — a single timeframe is
#: either leaning one way or it is ranging.
Bias = Literal["bullish", "bearish", "neutral"]
#: The aggregate adds "mixed": timeframes that actively disagree are a
#: different situation from timeframes that are all quiet.
ContextBias = Literal["bullish", "bearish", "neutral", "mixed"]

ContextTimeframe = Literal["1D", "4H", "1H", "15M", "5M"]

#: Slowest first — the order the UI lists them in. 1D exists for the swing
#: horizon; the faster modes give it no weight.
CONTEXT_TIMEFRAMES: tuple[ContextTimeframe, ...] = ("1D", "4H", "1H", "15M", "5M")

_EPS = 1e-9


@dataclass(frozen=True, slots=True)
class ContextConfig:
    """Weights and stability knobs for the slow lane.

    The weights are the editorial call: the 4H regime outranks the 1H bias,
    which outranks 15m structure. 5M is carried as *structural detail* and is
    given no vote in the badge at all — otherwise the badge would start
    tracking the fast lane, which is exactly what this layer exists to avoid.
    """

    weight_1d: float = 0.0
    weight_4h: float = 3.0
    weight_1h: float = 2.0
    weight_15m: float = 1.0
    weight_5m: float = 0.0

    # Weighted agreement (0-1) needed before the aggregate commits to a
    # direction rather than reading "neutral" (or "mixed", when the
    # timeframes are actively disagreeing).
    directional_agreement: float = 0.40
    # Agreement at or above this reads as "high" alignment downstream.
    high_agreement: float = 0.70
    # Consecutive rebuilds a new bias must survive before it is displayed.
    # There is deliberately no "decisive reading" override: unanimity across
    # two timeframes is an everyday occurrence, so an override would mean the
    # badge effectively never waits.
    flip_confirmations: int = 2

    # A read older than this is not trustworthy as context any more.
    read_ttl_seconds: float = 3_600.0
    # Fewest closed candles a timeframe needs before its read counts.
    min_candles: int = 40

    def weight(self, timeframe: str) -> float:
        return {
            "1D": self.weight_1d,
            "4H": self.weight_4h,
            "1H": self.weight_1h,
            "15M": self.weight_15m,
            "5M": self.weight_5m,
        }.get(timeframe, 0.0)


DEFAULT_CONTEXT_CONFIG = ContextConfig()


@dataclass(frozen=True, slots=True)
class TimeframeRead:
    """One timeframe's structural read, computed from closed candles only."""

    timeframe: ContextTimeframe
    bias: Bias
    trend: StructureTrend
    # Latest structural break on this timeframe: "bos" | "choch" | None.
    event: str | None
    # Label of the swing that produced it: HH/HL/LH/LL.
    event_label: str | None
    # Close-to-close move across the candles the read was computed from.
    change_pct: float
    bars: int
    # Close time of the last candle used, and when the read was computed.
    last_candle_time: int
    computed_at: float
    # The swings and liquidity behind the read, for the target/POI search.
    # Optional so a hand-built read (tests, fixtures) stays cheap to make.
    structure: StructureMap | None = None

    def is_stale(self, now: float, config: ContextConfig = DEFAULT_CONTEXT_CONFIG) -> bool:
        return now - self.computed_at >= config.read_ttl_seconds


@dataclass(frozen=True, slots=True)
class MarketContext:
    """The aggregate slow-lane view of one symbol.

    `bias` is what the card's HTF badge shows and is deliberately sticky;
    `pending_bias`/`pending_count` hold a challenger that has not yet earned
    the flip.
    """

    symbol: str
    bias: ContextBias
    # Weighted |agreement| among the voting timeframes, 0-1.
    agreement: float
    # Signed version of the same number: +1 fully bullish, -1 fully bearish.
    score: float
    reads: tuple[TimeframeRead, ...]
    updated_at: float
    # When `bias` last actually changed — how settled the badge is.
    bias_since: float
    pending_bias: ContextBias | None = None
    pending_count: int = 0

    def read(self, timeframe: str) -> TimeframeRead | None:
        for entry in self.reads:
            if entry.timeframe == timeframe:
                return entry
        return None

    def is_stale(self, now: float, config: ContextConfig = DEFAULT_CONTEXT_CONFIG) -> bool:
        """Stale when every read has aged out — a partially refreshed context
        is still usable."""
        return not self.reads or all(entry.is_stale(now, config) for entry in self.reads)


# ─────────────────────────────────────────────────────────────────────────────
# Per-timeframe read
# ─────────────────────────────────────────────────────────────────────────────


def _bias_from_lean(lean: str) -> Bias:
    if lean == "long":
        return "bullish"
    if lean == "short":
        return "bearish"
    return "neutral"


def read_timeframe(
    timeframe: ContextTimeframe,
    candles: list[Candle],
    now: float,
    config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
) -> TimeframeRead | None:
    """Structural read of one timeframe. `None` when there is not enough
    history to say anything — the layer stays silent rather than guessing.

    Callers must pass **closed** candles (`drop_unclosed_candle`): a forming
    bar would make the read change under the user for no structural reason.
    """
    if len(candles) < config.min_candles:
        return None

    structure = compute_market_structure(compute_pivots(candles))
    first_close = candles[0].close
    change = (candles[-1].close - first_close) / first_close * 100.0 if first_close > _EPS else 0.0
    event_swing = structure.event_swing
    # The map is built here rather than by a second pass elsewhere: pivots are
    # the expensive part and this is the one place they are already computed.
    structure_map = from_structure(timeframe, structure, candles[-1].close, len(candles), now)
    return TimeframeRead(
        timeframe=timeframe,
        bias=_bias_from_lean(structure_lean(structure)),
        trend=structure.trend,
        event=structure.event,
        event_label=event_swing.label if event_swing is not None else None,
        change_pct=round(change, 2),
        bars=len(candles),
        last_candle_time=candles[-1].time,
        computed_at=now,
        structure=structure_map,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Aggregation
# ─────────────────────────────────────────────────────────────────────────────


def aggregate_bias(
    reads: tuple[TimeframeRead, ...], config: ContextConfig = DEFAULT_CONTEXT_CONFIG
) -> tuple[ContextBias, float]:
    """Weighted vote over the voting timeframes → (bias, signed score).

    "mixed" is reserved for genuine conflict — timeframes pointing opposite
    ways — and is not the same as "neutral", which means nobody is leaning.
    Forcing a direction on a conflicted read is precisely the mistake this
    layer is meant to prevent.
    """
    total = 0.0
    signed = 0.0
    bullish = False
    bearish = False
    for entry in reads:
        weight = config.weight(entry.timeframe)
        if weight <= 0.0:
            continue
        total += weight
        if entry.bias == "bullish":
            signed += weight
            bullish = True
        elif entry.bias == "bearish":
            signed -= weight
            bearish = True
    if total <= _EPS:
        return "neutral", 0.0

    score = round(signed / total, 3)
    if score >= config.directional_agreement:
        return "bullish", score
    if score <= -config.directional_agreement:
        return "bearish", score
    # Below the directional bar: "mixed" when timeframes are pulling against
    # each other, "neutral" when nobody is pulling at all.
    return ("mixed" if bullish and bearish else "neutral"), score


def build_context(
    symbol: str,
    reads: tuple[TimeframeRead, ...],
    now: float,
    previous: MarketContext | None = None,
    config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
) -> MarketContext:
    """Folds fresh timeframe reads into a (sticky) context.

    Pure. A changed reading does not change the badge on its own: it has to be
    confirmed `flip_confirmations` times, or arrive decisively enough to clear
    `flip_override_agreement`.
    """
    ordered = tuple(sorted(reads, key=lambda r: CONTEXT_TIMEFRAMES.index(r.timeframe)))
    candidate, score = aggregate_bias(ordered, config)
    agreement = round(abs(score), 3)

    if previous is None:
        return MarketContext(
            symbol=symbol,
            bias=candidate,
            agreement=agreement,
            score=score,
            reads=ordered,
            updated_at=now,
            bias_since=now,
        )

    base = replace(previous, reads=ordered, agreement=agreement, score=score, updated_at=now)
    if candidate == previous.bias:
        # The challenger, if any, is abandoned the moment the reading agrees
        # with what is already displayed.
        return replace(base, pending_bias=None, pending_count=0)

    pending_count = previous.pending_count + 1 if previous.pending_bias == candidate else 1
    if pending_count >= config.flip_confirmations:
        return replace(base, bias=candidate, bias_since=now, pending_bias=None, pending_count=0)
    return replace(base, pending_bias=candidate, pending_count=pending_count)
