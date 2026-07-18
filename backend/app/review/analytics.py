"""Pure trade-analytics functions: RR, best/worst, best win-rate hour range,
session split, and scalp/intraday/swing style suitability.

No DB access, no pydantic — a `Sequence[ClosedTradeLike]` in, a
dataclass tree out. `service.py` loads `BybitTrade` rows (which already have
every attribute `ClosedTradeLike` needs) and passes them straight in; tests
construct lightweight dataclasses that satisfy the same Protocol.
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

from .constants import (
    HOUR_RANGE_EXPANSION_TOLERANCE_POINTS,
    INTRADAY_MAX_MS,
    MIN_HOUR_SAMPLE,
    MIN_ORDER_HISTORY_SAMPLE_FOR_STYLE,
    MIN_STOP_EVIDENCE_COVERAGE,
    MIN_STOP_EVIDENCE_TRADES,
    MIN_STYLE_SAMPLE,
    SCALP_MAX_MS,
    SESSION_ASIA,
    SESSION_LONDON,
)


class ClosedTradeLike(Protocol):
    id: str
    symbol: str
    side: str
    realized_pnl: float
    entry_price: float
    exit_price: float
    quantity: float
    stop_loss: float | None
    opened_at: datetime
    open_time_source: str
    closed_at: datetime


@dataclass(frozen=True)
class RRResult:
    mode: str  # "r_multiple" | "payoff_ratio"
    label: str
    sample_size: int
    coverage: float
    avg_r_multiple: float | None = None
    payoff_ratio: float | None = None
    expectancy_pct: float | None = None


@dataclass(frozen=True)
class HourRangeResult:
    start_hour_utc: int
    end_hour_utc: int
    win_rate: float
    sample_size: int


@dataclass(frozen=True)
class SessionStatsResult:
    n: int
    win_rate: float
    total_pnl: float


@dataclass(frozen=True)
class SessionSplitResult:
    asia: SessionStatsResult
    london: SessionStatsResult
    new_york: SessionStatsResult


@dataclass(frozen=True)
class StyleBucketResult:
    n: int
    win_rate: float
    total_pnl: float
    expectancy: float


@dataclass(frozen=True)
class StyleBucketsResult:
    scalp: StyleBucketResult
    intraday: StyleBucketResult
    swing: StyleBucketResult


@dataclass(frozen=True)
class StyleSuitabilityResult:
    buckets: StyleBucketsResult
    recommended: str | None
    confidence: str  # "low" | "high"
    data_quality: str  # "order_history" | "estimated_fallback"


@dataclass(frozen=True)
class AnalyticsResult:
    total_trades: int
    rr: RRResult
    best_trade: ClosedTradeLike | None
    worst_trade: ClosedTradeLike | None
    time_range: HourRangeResult | None
    worst_time_range: HourRangeResult | None
    sessions: SessionSplitResult
    style: StyleSuitabilityResult
    stop_evidence_coverage: float = field(default=0.0)


def compute_rr(trades: Sequence[ClosedTradeLike]) -> RRResult:
    total = len(trades)
    evidenced = [t for t in trades if t.stop_loss is not None]
    coverage = (len(evidenced) / total) if total > 0 else 0.0

    if len(evidenced) >= MIN_STOP_EVIDENCE_TRADES and coverage >= MIN_STOP_EVIDENCE_COVERAGE:
        r_multiples: list[float] = []
        for t in evidenced:
            assert t.stop_loss is not None
            risk = abs(t.entry_price - t.stop_loss) * t.quantity
            if risk <= 0:
                continue
            r_multiples.append(t.realized_pnl / risk)
        avg_r = sum(r_multiples) / len(r_multiples) if r_multiples else None
        return RRResult(
            mode="r_multiple",
            label="R-multiple (stop-based)",
            sample_size=len(r_multiples),
            coverage=coverage,
            avg_r_multiple=avg_r,
        )

    wins = [t.realized_pnl for t in trades if t.realized_pnl > 0]
    losses = [abs(t.realized_pnl) for t in trades if t.realized_pnl <= 0]
    win_rate = (len(wins) / total) if total > 0 else 0.0
    avg_win = sum(wins) / len(wins) if wins else 0.0
    avg_loss = sum(losses) / len(losses) if losses else 0.0
    payoff_ratio = (avg_win / avg_loss) if avg_loss > 0 else None
    expectancy_pct = (
        ((win_rate * avg_win - (1 - win_rate) * avg_loss) / avg_loss * 100)
        if avg_loss > 0
        else None
    )
    return RRResult(
        mode="payoff_ratio",
        label="% payoff (no stop on record)",
        sample_size=total,
        coverage=coverage,
        payoff_ratio=payoff_ratio,
        expectancy_pct=expectancy_pct,
    )


def select_best_worst[T: ClosedTradeLike](trades: Sequence[T]) -> tuple[T | None, T | None]:
    """Best/worst by realized PnL; ties broken deterministically by lowest id."""
    if not trades:
        return None, None
    best = min(trades, key=lambda t: (-t.realized_pnl, t.id))
    worst = min(trades, key=lambda t: (t.realized_pnl, t.id))
    return best, worst


def _bucket_by_hour(trades: Sequence[ClosedTradeLike]) -> dict[int, list[float]]:
    buckets: dict[int, list[float]] = defaultdict(list)
    for t in trades:
        buckets[t.opened_at.hour].append(t.realized_pnl)
    return buckets


def compute_hour_range(
    trades: Sequence[ClosedTradeLike], *, worst: bool = False
) -> HourRangeResult | None:
    """Best- (or worst-) winrate hour-of-day range (UTC), expanded to contiguous
    neighbors within `HOUR_RANGE_EXPANSION_TOLERANCE_POINTS` of the peak/trough
    winrate.

    With ``worst=True`` the pivot is the lowest-winrate hour instead of the
    highest; the expansion is otherwise identical (the tolerance check is
    symmetric). Hours are treated circularly (mod 24) so a pivot at 23:00 can
    expand through midnight into 00:00, 01:00, ...
    """
    hour_pnls = _bucket_by_hour(trades)
    hour_win_rate: dict[int, float] = {}
    for hour, pnls in hour_pnls.items():
        n = len(pnls)
        if n < MIN_HOUR_SAMPLE:
            continue
        wins = sum(1 for p in pnls if p > 0)
        hour_win_rate[hour] = (wins / n) * 100

    if not hour_win_rate:
        return None

    # Tie-break: lowest hour wins among equal win rates, for determinism.
    if worst:
        best_hour = min(hour_win_rate.items(), key=lambda kv: (kv[1], kv[0]))[0]
    else:
        best_hour = max(hour_win_rate.items(), key=lambda kv: (kv[1], -kv[0]))[0]
    best_wr = hour_win_rate[best_hour]

    back_count = 0
    h = best_hour
    while True:
        prv = (h - 1) % 24
        if prv in hour_win_rate and abs(hour_win_rate[prv] - best_wr) <= (
            HOUR_RANGE_EXPANSION_TOLERANCE_POINTS
        ):
            back_count += 1
            h = prv
            if back_count >= 24:
                break
        else:
            break

    forward_count = 0
    h = best_hour
    while True:
        nxt = (h + 1) % 24
        if nxt in hour_win_rate and abs(hour_win_rate[nxt] - best_wr) <= (
            HOUR_RANGE_EXPANSION_TOLERANCE_POINTS
        ):
            forward_count += 1
            h = nxt
            if forward_count >= 24:
                break
        else:
            break

    span = back_count + forward_count + 1
    if span >= 24:
        start_hour, end_hour = 0, 24
        included_hours = set(range(24))
    else:
        start_hour = (best_hour - back_count) % 24
        included_hours = {(start_hour + i) % 24 for i in range(span)}
        end_hour = (best_hour + forward_count + 1) % 24

    total_pnls = [p for h in included_hours for p in hour_pnls.get(h, [])]
    total_n = len(total_pnls)
    total_wins = sum(1 for p in total_pnls if p > 0)
    total_wr = (total_wins / total_n * 100) if total_n > 0 else 0.0

    return HourRangeResult(
        start_hour_utc=start_hour,
        end_hour_utc=end_hour,
        win_rate=total_wr,
        sample_size=total_n,
    )


def _session_stats(pnls: Sequence[float]) -> SessionStatsResult:
    n = len(pnls)
    wins = sum(1 for p in pnls if p > 0)
    win_rate = (wins / n * 100) if n > 0 else 0.0
    return SessionStatsResult(n=n, win_rate=win_rate, total_pnl=sum(pnls))


def _session_for_hour(hour: int) -> str:
    if SESSION_ASIA[0] <= hour < SESSION_ASIA[1]:
        return "asia"
    if SESSION_LONDON[0] <= hour < SESSION_LONDON[1]:
        return "london"
    return "new_york"


def compute_sessions(trades: Sequence[ClosedTradeLike]) -> SessionSplitResult:
    by_session: dict[str, list[float]] = {"asia": [], "london": [], "new_york": []}
    for t in trades:
        by_session[_session_for_hour(t.opened_at.hour)].append(t.realized_pnl)
    return SessionSplitResult(
        asia=_session_stats(by_session["asia"]),
        london=_session_stats(by_session["london"]),
        new_york=_session_stats(by_session["new_york"]),
    )


def _holding_ms(t: ClosedTradeLike) -> float:
    return (t.closed_at - t.opened_at).total_seconds() * 1000


def _bucket_for_duration(duration_ms: float) -> str:
    if duration_ms < SCALP_MAX_MS:
        return "scalp"
    if duration_ms <= INTRADAY_MAX_MS:
        return "intraday"
    return "swing"


def _style_bucket_stats(trades: Sequence[ClosedTradeLike]) -> StyleBucketResult:
    n = len(trades)
    pnls = [t.realized_pnl for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [abs(p) for p in pnls if p <= 0]
    win_rate_fraction = (len(wins) / n) if n > 0 else 0.0
    avg_win = sum(wins) / len(wins) if wins else 0.0
    avg_loss = sum(losses) / len(losses) if losses else 0.0
    expectancy = win_rate_fraction * avg_win - (1 - win_rate_fraction) * avg_loss
    return StyleBucketResult(
        n=n,
        win_rate=win_rate_fraction * 100,
        total_pnl=sum(pnls),
        expectancy=expectancy,
    )


def compute_style_suitability(trades: Sequence[ClosedTradeLike]) -> StyleSuitabilityResult:
    order_history_trades = [t for t in trades if t.open_time_source == "order_history"]
    if len(order_history_trades) >= MIN_ORDER_HISTORY_SAMPLE_FOR_STYLE:
        style_trades = order_history_trades
        data_quality = "order_history"
    else:
        style_trades = list(trades)
        data_quality = "estimated_fallback"

    by_bucket: dict[str, list[ClosedTradeLike]] = {"scalp": [], "intraday": [], "swing": []}
    for t in style_trades:
        by_bucket[_bucket_for_duration(_holding_ms(t))].append(t)

    stats = {name: _style_bucket_stats(ts) for name, ts in by_bucket.items()}
    eligible = {name: s for name, s in stats.items() if s.n >= MIN_STYLE_SAMPLE}

    if eligible:
        recommended = max(eligible.items(), key=lambda kv: kv[1].expectancy)[0]
        confidence = "high"
    else:
        recommended = None
        confidence = "low"

    return StyleSuitabilityResult(
        buckets=StyleBucketsResult(
            scalp=stats["scalp"], intraday=stats["intraday"], swing=stats["swing"]
        ),
        recommended=recommended,
        confidence=confidence,
        data_quality=data_quality,
    )


def compute_analytics(trades: Sequence[ClosedTradeLike]) -> AnalyticsResult:
    rr = compute_rr(trades)
    best_trade, worst_trade = select_best_worst(trades)
    return AnalyticsResult(
        total_trades=len(trades),
        rr=rr,
        best_trade=best_trade,
        worst_trade=worst_trade,
        time_range=compute_hour_range(trades),
        worst_time_range=compute_hour_range(trades, worst=True),
        sessions=compute_sessions(trades),
        style=compute_style_suitability(trades),
        stop_evidence_coverage=rr.coverage,
    )
