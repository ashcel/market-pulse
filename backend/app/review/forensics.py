"""Pure computations for the frozen trade-forensics definitions."""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from math import sqrt
from statistics import median
from typing import Protocol

FORENSICS_DEFINITIONS_VERSION = "1.0.0"
EFFICIENCY_MIN_MFE_PCT = 0.10
MIN_SIZING_SAMPLE = 5
MIN_WINDOW_CANDLES = 3
MAX_KLINE_CANDLES = 900
BOUNDARY_INFLATION_FLAG_RATIO = 0.25
LOCAL_TZ = timezone(timedelta(hours=8))

INTERVAL_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


class UnavailableReason(StrEnum):
    NOT_ENRICHED = "not_enriched"
    TESTNET_SOURCE = "testnet_source"
    ESTIMATED_OPEN_TIME = "estimated_open_time"
    UNDEFINED_FOR_PARTIAL_CLOSE = "undefined_for_partial_close"
    SYMBOL_UNRESOLVABLE = "symbol_unresolvable"
    RESOLUTION_TOO_COARSE = "resolution_too_coarse"
    PENDING_BAR_CLOSE = "pending_bar_close"
    KLINES_UNAVAILABLE = "klines_unavailable"
    INSUFFICIENT_CANDLES = "insufficient_candles"
    NO_STOP_ON_RECORD = "no_stop_on_record"
    ZERO_RISK_DISTANCE = "zero_risk_distance"
    NEGLIGIBLE_FAVORABLE_EXCURSION = "negligible_favorable_excursion"
    NO_PRIOR_TRADE_IN_WINDOW = "no_prior_trade_in_window"
    OVERLAPPING_POSITIONS = "overlapping_positions"
    INSUFFICIENT_SAMPLE = "insufficient_sample"
    DEGENERATE_COHORT = "degenerate_cohort"


@dataclass(frozen=True)
class MetricValue:
    available: bool
    value: float | None
    unit: str
    reason: UnavailableReason | None = None
    flags: list[str] = field(default_factory=list)
    forensics_version: str = FORENSICS_DEFINITIONS_VERSION

    def as_dict(self) -> dict[str, object]:
        """The one serialization of the §2 shape — persistence and API share it."""
        return {
            "available": self.available,
            "value": self.value,
            "unit": self.unit,
            "reason": self.reason.value if self.reason else None,
            "flags": list(self.flags),
            "forensics_version": self.forensics_version,
        }


class TradeLike(Protocol):
    id: str
    user_id: str
    symbol: str
    side: str
    entry_price: float
    exit_price: float
    quantity: float
    realized_pnl: float
    stop_loss: float | None
    close_trigger: str | None
    opened_at: datetime
    closed_at: datetime
    open_time_source: str


def _value(value: float, unit: str, flags: list[str] | None = None) -> MetricValue:
    return MetricValue(True, value, unit, flags=flags or [])


def _unavailable(reason: UnavailableReason, unit: str) -> MetricValue:
    return MetricValue(False, None, unit, reason=reason)


def choose_interval(holding_span_seconds: float) -> str:
    """Choose the finest supported interval requiring at most 900 candles."""
    span_ms = max(0.0, holding_span_seconds) * 1000
    for interval, interval_ms in INTERVAL_MS.items():
        if span_ms <= interval_ms * MAX_KLINE_CANDLES:
            return interval
    return "1d"


def normalize_timestamp(dt: datetime) -> int:
    """Convert naive local DB wall time, or an aware instant, to epoch ms."""
    aware = dt.replace(tzinfo=LOCAL_TZ) if dt.tzinfo is None else dt
    return int(aware.timestamp() * 1000)


def compute_window(t_open_ms: int, t_close_ms: int, interval_ms: int) -> dict[str, int]:
    if interval_ms <= 0:
        raise ValueError("interval_ms must be positive")
    first = (t_open_ms // interval_ms) * interval_ms
    last = ((t_close_ms - 1) // interval_ms) * interval_ms
    count = max(0, ((last - first) // interval_ms) + 1)
    return {"first_open_ms": first, "last_open_ms": last, "candle_count": count}


def not_enriched(trade: TradeLike) -> bool:
    """§3 reason 1 — a placeholder row whose closing fill was never matched."""
    return trade.entry_price <= 0 or trade.exit_price <= 0 or trade.quantity <= 0


def detect_partial_close_groups(trades: Sequence[TradeLike]) -> set[str]:
    """§7.5 heuristic — ids of rows that look like fragments of one scale-out."""
    buckets: dict[tuple[str, str, str, datetime], list[TradeLike]] = {}
    for trade in trades:
        buckets.setdefault(
            (trade.user_id, trade.symbol, trade.side, trade.opened_at), []
        ).append(trade)
    suspected: set[str] = set()
    for members in buckets.values():
        if len(members) < 2:
            continue
        for index, member in enumerate(members):
            twins = [
                other
                for other in members[index + 1 :]
                if abs(other.entry_price - member.entry_price)
                <= 1e-9 * max(abs(member.entry_price), 1.0)
                and other.opened_at < member.closed_at
                and member.opened_at < other.closed_at
            ]
            if twins:
                suspected.add(member.id)
                suspected.update(twin.id for twin in twins)
    return suspected


def excursion_unavailable_reason(
    trade: TradeLike,
    *,
    testnet: bool,
    partial_close_suspected: bool,
    symbol_resolvable: bool,
    interval_ms: int,
    candle_count: int,
    pending_bar_close: bool,
) -> UnavailableReason | None:
    """§3 evaluated top-to-bottom — the first matching condition wins."""
    span_ms = max(0, normalize_timestamp(trade.closed_at) - normalize_timestamp(trade.opened_at))
    if not_enriched(trade):
        return UnavailableReason.NOT_ENRICHED
    if testnet:
        return UnavailableReason.TESTNET_SOURCE
    if trade.open_time_source == "estimated":
        return UnavailableReason.ESTIMATED_OPEN_TIME
    if partial_close_suspected:
        return UnavailableReason.UNDEFINED_FOR_PARTIAL_CLOSE
    if not symbol_resolvable:
        return UnavailableReason.SYMBOL_UNRESOLVABLE
    if span_ms < MIN_WINDOW_CANDLES * interval_ms:
        return UnavailableReason.RESOLUTION_TOO_COARSE
    if pending_bar_close:
        return UnavailableReason.PENDING_BAR_CLOSE
    if candle_count == 0:
        return UnavailableReason.KLINES_UNAVAILABLE
    if candle_count < MIN_WINDOW_CANDLES:
        return UnavailableReason.INSUFFICIENT_CANDLES
    return None


def boundary_inflation_bound_pct(
    first_candle: dict[str, float | int], last_candle: dict[str, float | int], entry_price: float
) -> float:
    """§4.4 — the row's own error bar, in percent of entry."""
    if entry_price <= 0:
        return 0.0
    ranges = [
        float(candle["high"]) - float(candle["low"]) for candle in (first_candle, last_candle)
    ]
    return max(ranges) / entry_price * 100


def _with_boundary_flag(metric: MetricValue, bound_pct: float) -> MetricValue:
    """§4.4 — disclose when the boundary error bar is material against the value."""
    if not metric.available or metric.value is None:
        return metric
    if abs(metric.value) <= 0 or bound_pct <= BOUNDARY_INFLATION_FLAG_RATIO * abs(metric.value):
        return metric
    return MetricValue(
        metric.available, metric.value, metric.unit, metric.reason,
        [*metric.flags, "boundary_inflated"], metric.forensics_version,
    )


def disclose_boundary_inflation(
    metrics: dict[str, MetricValue], bound_pct: float
) -> dict[str, MetricValue]:
    """Flag the percent-of-entry representations, which share the bound's unit."""
    return {
        key: _with_boundary_flag(metric, bound_pct)
        if metric.unit == "percent_of_entry"
        else metric
        for key, metric in metrics.items()
    }


def _risk_metric(value: float, stop_loss: float | None, entry_price: float) -> MetricValue:
    if stop_loss is None:
        return _unavailable(UnavailableReason.NO_STOP_ON_RECORD, "r_multiple")
    risk = abs(entry_price - stop_loss)
    if risk == 0:
        return _unavailable(UnavailableReason.ZERO_RISK_DISTANCE, "r_multiple")
    return _value(value / risk, "r_multiple")


def compute_mae(
    side: str, entry_price: float, quantity: float, low_min: float, high_max: float,
    stop_loss: float | None = None,
) -> dict[str, MetricValue]:
    long = side.upper() == "LONG"
    price = max(0.0, entry_price - low_min) if long else max(0.0, high_max - entry_price)
    flags = ["adverse_excursion_none"] if price == 0 else []
    return {
        "price": _value(price * quantity, "quote_currency", flags),
        "percent": _value(price / entry_price * 100, "percent_of_entry", flags),
        "r": _risk_metric(price, stop_loss, entry_price),
    }


def compute_mfe(
    side: str, entry_price: float, quantity: float, low_min: float, high_max: float,
    stop_loss: float | None = None,
) -> dict[str, MetricValue]:
    long = side.upper() == "LONG"
    price = max(0.0, high_max - entry_price) if long else max(0.0, entry_price - low_min)
    return {
        "price": _value(price * quantity, "quote_currency"),
        "percent": _value(price / entry_price * 100, "percent_of_entry"),
        "r": _risk_metric(price, stop_loss, entry_price),
    }


def exit_efficiency(
    side: str, entry_price: float, exit_price: float, low_min: float, high_max: float,
) -> MetricValue:
    long = side.upper() == "LONG"
    mfe_price = max(0.0, high_max - entry_price) if long else max(0.0, entry_price - low_min)
    if mfe_price / entry_price * 100 < EFFICIENCY_MIN_MFE_PCT:
        return _unavailable(UnavailableReason.NEGLIGIBLE_FAVORABLE_EXCURSION, "ratio_percent")
    realized = exit_price - entry_price if side.upper() == "LONG" else entry_price - exit_price
    efficiency = realized / mfe_price * 100
    if efficiency > 100:
        return _value(100.0, "ratio_percent", ["exit_outside_kline_range"])
    return _value(efficiency, "ratio_percent")


STOP_DISCIPLINE_UNITS = {
    "slippage_adverse": "quote_currency", "slippage_adverse_pct": "percent_of_entry",
    "slippage_adverse_r": "r_multiple", "violation_depth_r": "r_multiple",
    "realized_r": "r_multiple",
}


def stop_evidence_of(stop_loss: float | None, close_trigger: str | None) -> str:
    """§5.4 — `hit` | `liquidated` | `absent`, read off the exchange row only."""
    if stop_loss is not None:
        return "hit"
    if close_trigger == "liquidation":
        return "liquidated"
    return "absent"


def stop_discipline(
    side: str, entry_price: float, exit_price: float, stop_loss: float | None,
    close_trigger: str | None = None,
    low_min: float | None = None, high_max: float | None = None,
    depth_unavailable: UnavailableReason | None = None,
) -> dict[str, MetricValue | str | bool]:
    """§5.4. Numeric sub-fields exist only in the `hit` branch — R by construction."""
    evidence = stop_evidence_of(stop_loss, close_trigger)
    breach = evidence == "liquidated"
    if stop_loss is None:
        blocked: dict[str, MetricValue | str | bool] = {
            key: _unavailable(UnavailableReason.NO_STOP_ON_RECORD, unit)
            for key, unit in STOP_DISCIPLINE_UNITS.items()
        }
        return {**blocked, "stop_evidence": evidence, "discipline_breach": breach}
    risk = abs(entry_price - stop_loss)
    if risk == 0:
        blocked = {
            key: _unavailable(UnavailableReason.ZERO_RISK_DISTANCE, unit)
            for key, unit in STOP_DISCIPLINE_UNITS.items()
        }
        return {**blocked, "stop_evidence": evidence, "discipline_breach": breach}
    long = side.upper() == "LONG"
    slippage = stop_loss - exit_price if long else exit_price - stop_loss
    realized = exit_price - entry_price if long else entry_price - exit_price
    if depth_unavailable is not None or low_min is None or high_max is None:
        depth = _unavailable(
            depth_unavailable or UnavailableReason.KLINES_UNAVAILABLE, "r_multiple"
        )
    else:
        raw = max(0.0, stop_loss - low_min) if long else max(0.0, high_max - stop_loss)
        depth = _value(raw / risk, "r_multiple")
    return {
        "slippage_adverse": _value(slippage, "quote_currency"),
        "slippage_adverse_pct": _value(slippage / entry_price * 100, "percent_of_entry"),
        "slippage_adverse_r": _value(slippage / risk, "r_multiple"),
        "violation_depth_r": depth,
        "realized_r": _value(realized / risk, "r_multiple"),
        "stop_evidence": evidence,
        "discipline_breach": breach,
    }


def _reentry_blocked(reason: UnavailableReason) -> dict[str, MetricValue | bool | None]:
    return {
        "latency": _unavailable(reason, "seconds"),
        "same_direction": None,
        "after_loss": None,
    }


def reentry_latency(
    trade: TradeLike,
    trades: Sequence[TradeLike],
    partial_close_ids: frozenset[str] = frozenset(),
) -> dict[str, MetricValue | bool | None]:
    """§5.5. Prerequisite states (1, 3, 4) gate the pair before any subtraction."""
    if not_enriched(trade):
        return _reentry_blocked(UnavailableReason.NOT_ENRICHED)
    if trade.open_time_source == "estimated":
        return _reentry_blocked(UnavailableReason.ESTIMATED_OPEN_TIME)
    if trade.id in partial_close_ids:
        return _reentry_blocked(UnavailableReason.UNDEFINED_FOR_PARTIAL_CLOSE)
    candidates = [
        item for item in trades
        if item is not trade and item.user_id == trade.user_id and item.symbol == trade.symbol
        and item.opened_at <= trade.opened_at
    ]
    if any(item.closed_at > trade.opened_at for item in candidates):
        return _reentry_blocked(UnavailableReason.OVERLAPPING_POSITIONS)
    prior = [item for item in candidates if item.closed_at <= trade.opened_at]
    if not prior:
        return _reentry_blocked(UnavailableReason.NO_PRIOR_TRADE_IN_WINDOW)
    previous = max(prior, key=lambda item: normalize_timestamp(item.closed_at))
    if not_enriched(previous):
        return _reentry_blocked(UnavailableReason.NOT_ENRICHED)
    if previous.open_time_source == "estimated":
        return _reentry_blocked(UnavailableReason.ESTIMATED_OPEN_TIME)
    if previous.id in partial_close_ids:
        return _reentry_blocked(UnavailableReason.UNDEFINED_FOR_PARTIAL_CLOSE)
    gap_ms = normalize_timestamp(trade.opened_at) - normalize_timestamp(previous.closed_at)
    latency = gap_ms / 1000
    flags = ["immediate_reversal"] if latency == 0 else []
    return {
        "latency": _value(latency, "seconds", flags),
        "same_direction": trade.side == previous.side,
        "after_loss": previous.realized_pnl < 0,
    }


def sizing_variance(
    trades: Sequence[TradeLike], partial_close_ids: frozenset[str] = frozenset()
) -> dict[str, object]:
    """§5.6. Suspected scale-out fragments stay in the cohort but are counted out loud."""
    enriched = [trade for trade in trades if not not_enriched(trade)]
    partial_rows = sum(1 for trade in enriched if trade.id in partial_close_ids)
    cohort = {
        "n": len(enriched),
        "excluded": len(trades) - len(enriched),
        "partial_close_rows": partial_rows,
    }
    if len(enriched) < MIN_SIZING_SAMPLE:
        return {
            **cohort,
            "cv_percent": _unavailable(UnavailableReason.INSUFFICIENT_SAMPLE, "ratio_percent"),
        }
    risk_based = all(
        trade.stop_loss is not None and abs(trade.entry_price - trade.stop_loss) > 0
        for trade in enriched
    )
    sizes = [
        abs(trade.entry_price - trade.stop_loss) * trade.quantity
        if risk_based and trade.stop_loss is not None
        else trade.entry_price * trade.quantity
        for trade in enriched
    ]
    mean = sum(sizes) / len(sizes)
    if mean <= 0 or len(set(sizes)) == 1:
        return {
            **cohort,
            "mode": "risk_based" if risk_based else "notional_based",
            "cv_percent": _unavailable(UnavailableReason.DEGENERATE_COHORT, "ratio_percent"),
        }
    ordered = sorted(sizes)
    midpoint = len(ordered) // 2
    lower = ordered[:midpoint]
    upper = ordered[midpoint + 1:] if len(ordered) % 2 else ordered[midpoint:]
    sigma = sqrt(sum((size - mean) ** 2 for size in sizes) / len(sizes))
    med = median(ordered)
    return {
        **cohort,
        "mode": "risk_based" if risk_based else "notional_based",
        "sizes": sizes,
        "trade_ids": [trade.id for trade in enriched],
        "mean": _value(mean, "quote_currency"),
        "cv_percent": _value(sigma / mean * 100, "ratio_percent"),
        "median": _value(med, "quote_currency"),
        "q1": _value(median(lower), "quote_currency"),
        "q3": _value(median(upper), "quote_currency"),
        "iqr": _value(median(upper) - median(lower), "quote_currency"),
        "size_ratios": [_value(size / med, "unitless") for size in sizes],
    }
