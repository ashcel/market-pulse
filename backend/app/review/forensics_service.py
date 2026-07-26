"""Persist the §2 `MetricValue` shape for every synced trade.

The block-level unavailable reason is resolved once per trade in the fixed §3
order, then applied to every metric it governs. A trade that closed inside a
still-forming bar writes **no row at all** (§4.5) — forensics rows are
write-once per `forensics_version`, so a provisional value is never published.
"""

from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.binance_review.models import BinanceTrade
from app.worker.binance import fetch_klines_raw

from .forensics import (
    FORENSICS_DEFINITIONS_VERSION,
    INTERVAL_MS,
    STOP_DISCIPLINE_UNITS,
    MetricValue,
    UnavailableReason,
    boundary_inflation_bound_pct,
    choose_interval,
    compute_mae,
    compute_mfe,
    compute_window,
    detect_partial_close_groups,
    disclose_boundary_inflation,
    excursion_unavailable_reason,
    exit_efficiency,
    normalize_timestamp,
    reentry_latency,
    sizing_variance,
    stop_discipline,
)
from .models import TradeForensics

#: The excursion block — every one of these shares the block-level §3 reason.
_UNITS = {
    "mae_price": "quote_currency", "mae_percent": "percent_of_entry", "mae_r": "r_multiple",
    "mfe_price": "quote_currency", "mfe_percent": "percent_of_entry", "mfe_r": "r_multiple",
    "exit_efficiency": "ratio_percent",
}


def _blocked(reason: UnavailableReason) -> dict[str, MetricValue]:
    return {key: MetricValue(False, None, unit, reason=reason) for key, unit in _UNITS.items()}


def plan_window(trade: BinanceTrade) -> tuple[str, dict[str, int]]:
    """The interval and candle window this trade is measured on."""
    span_ms = normalize_timestamp(trade.closed_at) - normalize_timestamp(trade.opened_at)
    interval = choose_interval(max(0, span_ms) / 1000)
    window = compute_window(
        normalize_timestamp(trade.opened_at),
        normalize_timestamp(trade.closed_at),
        INTERVAL_MS[interval],
    )
    return interval, window


def build_forensics(
    trade: BinanceTrade,
    trades: list[BinanceTrade],
    klines: list[dict[str, float | int]],
    *,
    testnet: bool,
    partial_close_ids: frozenset[str],
    cohort: dict[str, object],
    now_ms: int,
) -> dict[str, object] | None:
    """Pure assembly of one row's payload. `None` means: do not write yet."""
    interval, window = plan_window(trade)
    candles = sorted(
        (
            item for item in klines
            if window["first_open_ms"] <= int(item["open_time"]) <= window["last_open_ms"]
        ),
        key=lambda item: int(item["open_time"]),
    )
    pending = window["last_open_ms"] + INTERVAL_MS[interval] > now_ms
    reason = excursion_unavailable_reason(
        trade,
        testnet=testnet,
        partial_close_suspected=trade.id in partial_close_ids,
        symbol_resolvable=bool(trade.symbol),
        interval_ms=INTERVAL_MS[interval],
        candle_count=len(candles),
        pending_bar_close=pending,
    )
    if reason is UnavailableReason.PENDING_BAR_CLOSE:
        return None

    bound_pct = None
    if reason is None:
        low_min = min(float(item["low"]) for item in candles)
        high_max = max(float(item["high"]) for item in candles)
        bound_pct = boundary_inflation_bound_pct(candles[0], candles[-1], trade.entry_price)
        args = (trade.side, trade.entry_price, trade.quantity, low_min, high_max, trade.stop_loss)
        mae = compute_mae(*args)
        mfe = compute_mfe(*args)
        metrics = {
            "mae_price": mae["price"], "mae_percent": mae["percent"], "mae_r": mae["r"],
            "mfe_price": mfe["price"], "mfe_percent": mfe["percent"], "mfe_r": mfe["r"],
            "exit_efficiency": exit_efficiency(
                trade.side, trade.entry_price, trade.exit_price, low_min, high_max
            ),
        }
        metrics = disclose_boundary_inflation(metrics, bound_pct)
        discipline = stop_discipline(
            trade.side, trade.entry_price, trade.exit_price, trade.stop_loss,
            trade.close_trigger, low_min, high_max,
        )
    else:
        metrics = _blocked(reason)
        discipline = stop_discipline(
            trade.side, trade.entry_price, trade.exit_price, trade.stop_loss,
            trade.close_trigger, depth_unavailable=reason,
        )

    reentry = reentry_latency(trade, trades, partial_close_ids)
    latency = reentry["latency"]
    assert isinstance(latency, MetricValue)
    metrics["reentry_latency_seconds"] = latency
    for key in STOP_DISCIPLINE_UNITS:
        value = discipline[key]
        assert isinstance(value, MetricValue)
        metrics[key] = value
    metrics.update(_sizing_metrics(trade, cohort))

    return {
        "forensics_version": FORENSICS_DEFINITIONS_VERSION,
        "kline_interval": interval,
        "kline_candles_in_window": len(candles),
        "boundary_inflation_bound_pct": bound_pct,
        "metrics": {key: metric.as_dict() for key, metric in metrics.items()},
        "stop_evidence": discipline["stop_evidence"],
        "discipline_breach": discipline["discipline_breach"],
        "partial_close_suspected": trade.id in partial_close_ids,
        "reentry_same_direction": reentry["same_direction"],
        "reentry_after_loss": reentry["after_loss"],
        "sizing_mode": cohort.get("mode"),
        "sizing_n": cohort.get("n"),
        "sizing_excluded": cohort.get("excluded"),
        "sizing_partial_close_rows": cohort.get("partial_close_rows"),
    }


def _sizing_metrics(trade: BinanceTrade, cohort: dict[str, object]) -> dict[str, MetricValue]:
    """This trade's own size against the cohort, plus the cohort's dispersion."""
    cv = cohort.get("cv_percent")
    assert isinstance(cv, MetricValue)
    metrics: dict[str, MetricValue] = {"sizing_cv_percent": cv}
    for key in ("median", "iqr", "q1", "q3", "mean"):
        value = cohort.get(key)
        if isinstance(value, MetricValue):
            metrics[f"sizing_{key}"] = value
    trade_ids = cohort.get("trade_ids")
    sizes = cohort.get("sizes")
    median = cohort.get("median")
    if (
        isinstance(trade_ids, list) and isinstance(sizes, list)
        and isinstance(median, MetricValue) and median.value
        and trade.id in trade_ids
    ):
        own = sizes[trade_ids.index(trade.id)]
        metrics["sizing_notional"] = MetricValue(True, own, "quote_currency")
        metrics["sizing_size_ratio"] = MetricValue(True, own / median.value, "unitless")
    else:
        reason = cv.reason or UnavailableReason.INSUFFICIENT_SAMPLE
        metrics["sizing_notional"] = MetricValue(False, None, "quote_currency", reason=reason)
        metrics["sizing_size_ratio"] = MetricValue(False, None, "unitless", reason=reason)
    return metrics


async def compute_forensics_for_user(
    db: AsyncSession, user_id: str, testnet: bool = False
) -> int:
    trades = list((await db.scalars(
        select(BinanceTrade).where(BinanceTrade.user_id == user_id).order_by(BinanceTrade.opened_at)
    )).all())
    existing_ids = set((await db.scalars(
        select(TradeForensics.binance_trade_id).where(
            TradeForensics.user_id == user_id,
            TradeForensics.forensics_version == FORENSICS_DEFINITIONS_VERSION,
        )
    )).all())
    partial_close_ids = frozenset(detect_partial_close_groups(trades))
    cohort = sizing_variance(trades, partial_close_ids)
    now_ms = int(datetime.now(UTC).timestamp() * 1000)

    written = 0
    for trade in trades:
        if trade.id in existing_ids:
            continue
        interval, window = plan_window(trade)
        klines = await fetch_klines_raw(
            trade.symbol, interval, min(900, max(1, window["candle_count"])),
            end_time=window["last_open_ms"] + INTERVAL_MS[interval] - 1,
        )
        payload = build_forensics(
            trade, trades, klines,
            testnet=testnet, partial_close_ids=partial_close_ids,
            cohort=cohort, now_ms=now_ms,
        )
        if payload is None:  # pending_bar_close — recompute on a later tick
            continue
        db.add(TradeForensics(user_id=user_id, binance_trade_id=trade.id, **payload))
        written += 1
    await db.commit()
    return written


async def get_forensics(db: AsyncSession, user_id: str, trade_id: str) -> TradeForensics:
    row = await db.scalar(select(TradeForensics).where(
        TradeForensics.user_id == user_id, TradeForensics.binance_trade_id == trade_id
    ))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Forensics not found")
    return row


async def list_forensics(
    db: AsyncSession, user_id: str, page: int, per_page: int
) -> tuple[list[TradeForensics], int]:
    where = TradeForensics.user_id == user_id
    total = await db.scalar(select(func.count()).select_from(TradeForensics).where(where)) or 0
    rows = list((await db.scalars(
        select(TradeForensics).where(where).order_by(TradeForensics.created_at.desc())
        .offset((page - 1) * per_page).limit(per_page)
    )).all())
    return rows, total
