"""Followed-signal tracking + the shared exit-level walk.

``walk_exit_levels`` is the one first-touch-wins convention every settlement
path uses: within a single bar the stop is checked first (conservative), then
target 2, then target 1. Ported verbatim from the TS engine's ``tracker.ts``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from smc.hysteresis import iso_from_ms, parse_iso_ms
from smc.intent import TradingIntent
from smc.mock_candles import STEP_SECONDS, TokenTimeframe
from smc.quant import SetupType
from smc.types import Candle, MarketType

# "active" is the only open state — following a signal means you've entered.
TrackedSignalStatus = Literal["active", "target1-hit", "target2-hit", "stopped-out"]


def is_terminal_status(status: TrackedSignalStatus) -> bool:
    return status != "active"


@dataclass(slots=True)
class TrackedSignal:
    id: str
    symbol: str
    intent: TradingIntent
    direction: Literal["long", "short"]
    setup_type: SetupType
    # Execution timeframe the plan was built on.
    timeframe: TokenTimeframe
    # The engine's ideal entry zone at follow time, kept for reference.
    entry_low: float
    entry_high: float
    # The price the user confirmed they actually entered at.
    entry_price: float
    stop: float
    target1: float
    target2: float
    confidence_at_follow: float
    followed_at: str
    status: TrackedSignalStatus
    # Binance market the signal priced against; None on older records (spot).
    market: MarketType | None = None
    close_price: float | None = None
    closed_at: str | None = None
    result_r: float | None = None
    # Provenance — engine version / config / commit at follow time.
    engine_version: str | None = None
    config_hash: str | None = None
    git_sha: str | None = None


@dataclass(slots=True)
class TrackedPatch:
    """The fields a settlement pass may change on a tracked signal."""

    status: TrackedSignalStatus
    close_price: float
    closed_at: str
    result_r: float


def _round(value: float, digits: int = 2) -> float:
    scale = 10.0**digits
    return math.floor(value * scale + 0.5) / scale


def evaluate_tracked_signal(
    signal: TrackedSignal, latest_price: float, now_iso: str
) -> TrackedPatch | None:
    """Advances one tracked signal against a fresh price tick. Returns a patch
    to merge, or None when nothing changed. Known limitation: only sees polled
    last price, not intrabar highs/lows — an accepted v1 gap."""
    if not math.isfinite(latest_price) or latest_price <= 0:
        return None
    if is_terminal_status(signal.status):
        return None

    long = signal.direction == "long"
    risk_per_unit = abs(signal.entry_price - signal.stop)

    def result_r(exit_: float) -> float:
        if risk_per_unit <= 0:
            return 0
        gain = exit_ - signal.entry_price if long else signal.entry_price - exit_
        return _round(gain / risk_per_unit, 2)

    stop_hit = latest_price <= signal.stop if long else latest_price >= signal.stop
    if stop_hit:
        return TrackedPatch(
            status="stopped-out",
            close_price=latest_price,
            closed_at=now_iso,
            result_r=result_r(signal.stop),
        )
    target2_hit = latest_price >= signal.target2 if long else latest_price <= signal.target2
    if target2_hit:
        return TrackedPatch(
            status="target2-hit",
            close_price=latest_price,
            closed_at=now_iso,
            result_r=result_r(signal.target2),
        )
    target1_hit = latest_price >= signal.target1 if long else latest_price <= signal.target1
    if target1_hit:
        return TrackedPatch(
            status="target1-hit",
            close_price=latest_price,
            closed_at=now_iso,
            result_r=result_r(signal.target1),
        )
    return None


@dataclass(slots=True)
class ExitLevels:
    direction: Literal["long", "short"]
    entry: float
    stop: float
    target1: float
    target2: float


@dataclass(slots=True)
class ExitEvent:
    status: Literal["stopped-out", "target1-hit", "target2-hit"]
    # The level that produced the exit (stop or target price).
    exit_level: float
    # Open time (sec) of the bar that touched the level.
    bar_time: int
    result_r: float


def walk_exit_levels(levels: ExitLevels, bars: list[Candle]) -> ExitEvent | None:
    """Walks closed bars first-touch-wins using intrabar highs/lows. Within a
    single bar the stop is checked first, then target 2, then target 1."""
    long = levels.direction == "long"
    risk_per_unit = abs(levels.entry - levels.stop)

    def result_r(exit_: float) -> float:
        if risk_per_unit <= 0:
            return 0
        gain = exit_ - levels.entry if long else levels.entry - exit_
        return _round(gain / risk_per_unit, 2)

    for bar in bars:
        if bar.low <= levels.stop if long else bar.high >= levels.stop:
            return ExitEvent(
                status="stopped-out",
                exit_level=levels.stop,
                bar_time=bar.time,
                result_r=result_r(levels.stop),
            )
        if bar.high >= levels.target2 if long else bar.low <= levels.target2:
            return ExitEvent(
                status="target2-hit",
                exit_level=levels.target2,
                bar_time=bar.time,
                result_r=result_r(levels.target2),
            )
        if bar.high >= levels.target1 if long else bar.low <= levels.target1:
            return ExitEvent(
                status="target1-hit",
                exit_level=levels.target1,
                bar_time=bar.time,
                result_r=result_r(levels.target1),
            )
    return None


def settle_tracked_signal_with_candles(
    signal: TrackedSignal, closed_bars: list[Candle]
) -> TrackedPatch | None:
    """Catch-up settlement against closed klines: sees intrabar highs/lows, so
    wicks through a level between polls are no longer missed. Only bars that
    opened after the follow time count — the bar in progress at follow time
    partially predates the entry."""
    if is_terminal_status(signal.status):
        return None
    followed_at_sec = parse_iso_ms(signal.followed_at) / 1000
    if not math.isfinite(followed_at_sec):
        return None

    bars = [c for c in closed_bars if c.time > followed_at_sec]
    exit_ = walk_exit_levels(
        ExitLevels(
            direction=signal.direction,
            entry=signal.entry_price,
            stop=signal.stop,
            target1=signal.target1,
            target2=signal.target2,
        ),
        bars,
    )
    if exit_ is None:
        return None

    return TrackedPatch(
        status=exit_.status,
        close_price=exit_.exit_level,
        closed_at=iso_from_ms((exit_.bar_time + STEP_SECONDS[signal.timeframe]) * 1000),
        result_r=exit_.result_r,
    )


@dataclass(slots=True)
class TrackedSignalSummary:
    total: int
    open: int
    closed: int
    wins: int
    losses: int
    win_rate: float
    average_r: float
    # True when the closed sample is too small (<5) to be meaningful.
    low_sample: bool


_MIN_RELIABLE_TRACKED_TRADES = 5


def summarize_tracked_signals(signals: list[TrackedSignal]) -> TrackedSignalSummary:
    """Aggregate stats over followed signals."""
    closed = [s for s in signals if is_terminal_status(s.status)]
    wins = [s for s in closed if s.status in ("target1-hit", "target2-hit")]
    losses = [s for s in closed if s.status == "stopped-out"]
    r_values = [s.result_r if s.result_r is not None else 0 for s in closed]
    average_r = sum(r_values) / len(r_values) if r_values else 0

    return TrackedSignalSummary(
        total=len(signals),
        open=len(signals) - len(closed),
        closed=len(closed),
        wins=len(wins),
        losses=len(losses),
        win_rate=_round(len(wins) / len(closed) * 100, 1) if closed else 0,
        average_r=_round(average_r, 2),
        low_sample=0 < len(closed) < _MIN_RELIABLE_TRACKED_TRADES,
    )
