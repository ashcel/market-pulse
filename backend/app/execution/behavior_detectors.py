"""Deterministic behavior detectors — M9-T11 (EDR 0020 decision 2).

Pure functions: (trade_history, now) -> frozenset[str] of active flags.
No DB, no network, no AI. Three detectors:

1. REVENGE: losing close + same-symbol re-entry within window, new size > prior.
2. OVERTRADING: recent frequency exceeds baseline multiplier * historical rate.
3. TILT: last N trades show monotonically escalating risk%, or max > threshold*median.

These populate ``AccountState.active_behavior_flags``; the risk engine then
checks the constitution's ``binding_cooldowns`` to decide if each is binding.
"""

import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

from .constants import (
    OVERTRADING_BASELINE_MULTIPLIER,
    OVERTRADING_LOOKBACK_DAYS,
    OVERTRADING_MIN_TRADES,
    OVERTRADING_WINDOW_HOURS,
    REVENGE_WINDOW_MINUTES,
    TILT_RISK_THRESHOLD_MULTIPLIER,
    TILT_WINDOW_TRADES,
)


@dataclass(frozen=True)
class TradeRecord:
    symbol: str
    opened_at: datetime
    closed_at: datetime
    realized_pnl: Decimal
    notional_size: Decimal
    risk_percent: Decimal
    side: str


def detect_revenge(
    trades: list[TradeRecord],
    symbol: str,
    now: datetime,
    window_minutes: int = REVENGE_WINDOW_MINUTES,
) -> bool:
    """True if a losing close was followed by a larger re-entry on the same symbol
    within ``window_minutes`` and the loss happened recently (still within window).
    """
    sym_trades = [t for t in trades if t.symbol == symbol]
    if len(sym_trades) < 2:
        return False

    sym_trades.sort(key=lambda t: t.opened_at)
    last_trade = sym_trades[-1]
    prev_trade = sym_trades[-2]

    # Gap between prior close and re-entry must be within the window.
    gap = last_trade.opened_at - prev_trade.closed_at
    window = timedelta(minutes=window_minutes)
    if gap > window or gap < timedelta(0):
        return False

    # Prior close must be recent (still within the cooldown window from now).
    if now - prev_trade.closed_at > window:
        return False

    # The prior trade must have been a loss.
    if prev_trade.realized_pnl >= 0:
        return False

    # The re-entry must be larger (escalated risk = revenge pattern).
    return last_trade.notional_size > prev_trade.notional_size


def detect_overtrading(
    trades: list[TradeRecord],
    now: datetime,
    window_hours: int = OVERTRADING_WINDOW_HOURS,
    lookback_days: int = OVERTRADING_LOOKBACK_DAYS,
    baseline_multiplier: float = OVERTRADING_BASELINE_MULTIPLIER,
    min_trades: int = OVERTRADING_MIN_TRADES,
) -> bool:
    """True if recent trade frequency exceeds baseline * multiplier.

    Requires at least ``min_trades`` in the recent window before flagging
    (prevents false positives on users with very low historical activity).
    """
    window_start = now - timedelta(hours=window_hours)
    baseline_start = window_start - timedelta(days=lookback_days)

    window_trades = 0
    baseline_trades = 0

    for t in trades:
        if t.opened_at > window_start and t.opened_at <= now:
            window_trades += 1
        elif t.opened_at > baseline_start and t.opened_at <= window_start:
            baseline_trades += 1

    if window_trades < min_trades:
        return False

    baseline_per_day = baseline_trades / lookback_days if lookback_days > 0 else 0.0
    window_per_day = window_trades * (24.0 / window_hours)

    return window_per_day > baseline_multiplier * baseline_per_day


def detect_tilt(
    trades: list[TradeRecord],
    window_trades: int = TILT_WINDOW_TRADES,
    threshold_multiplier: float = TILT_RISK_THRESHOLD_MULTIPLIER,
) -> bool:
    """True if the last N trades show escalating risk.

    Triggered by either:
    - Monotonically increasing risk_percent across the window.
    - Max risk in the window > threshold_multiplier * median risk.
    """
    if len(trades) < window_trades:
        return False

    sorted_trades = sorted(trades, key=lambda t: t.opened_at)
    last_window = sorted_trades[-window_trades:]

    risks = [t.risk_percent for t in last_window]

    # Monotonically increasing risk_pct
    monotonic = all(risks[i] > risks[i - 1] for i in range(1, len(risks)))
    if monotonic:
        return True

    median_risk = statistics.median(risks)
    max_risk = max(risks)

    return bool(max_risk > Decimal(str(threshold_multiplier)) * median_risk and median_risk > 0)


def evaluate_behavior_flags(
    trades: list[TradeRecord],
    symbol: str,
    now: datetime,
) -> frozenset[str]:
    """Return the set of active detector names (subset of KNOWN_BEHAVIOR_DETECTORS).

    These populate ``AccountState.active_behavior_flags``; the risk engine
    then checks the constitution's ``binding_cooldowns`` to decide if each
    flag results in a hard rejection or is advisory-only.
    """
    flags: set[str] = set()
    if detect_revenge(trades, symbol, now):
        flags.add("revenge")
    if detect_overtrading(trades, now):
        flags.add("overtrading")
    if detect_tilt(trades):
        flags.add("tilt")
    return frozenset(flags)
