"""Forward returns — what an asset actually did after a given bar.

The one computation the whole evidence plane rests on, and the one place a
lookahead bug would poison every downstream statistic silently. So the
no-lookahead property is structural here, not a convention to remember:

  - The input is a chronologically ascending list of **closed** candles. A
    forming candle has no final close, and including it would let a row be
    written from a price that has not happened yet.
  - The return for the bar at index ``i`` over horizon ``h`` is derived from
    ``closes[i]`` and ``closes[i + h]``. It is emitted only when ``i + h`` is
    inside the list, so a row exists exactly when the future it describes has
    already occurred.
  - Nothing is interpolated, padded, or carried forward. A gap in the series
    yields fewer rows, never an invented one.

This mirrors the two-loop pattern in Ch. 5 of *Python for Algorithmic Trading
Cookbook* (historic returns, then forward returns by shifting them back), with
the shift written out explicitly because the guarantee above is the point of
the module.

Pure: no I/O, no clock reads. Every row is reproducible from its inputs.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from smc.types import Candle

from .constants import BAR_SECONDS, BASE_INTERVAL, FORWARD_RETURN_VERSION, HORIZONS


@dataclass(frozen=True, slots=True)
class ForwardReturnRow:
    """One (symbol, bar, horizon) measurement, ready to persist."""

    symbol: str
    #: When the anchor bar closed — the instant `base_close` became
    #: knowable. See `_observed_at`.
    observed_at: datetime
    horizon: str
    horizon_bars: int
    base_close: float
    forward_close: float
    #: Simple return, ``forward/base - 1``. Not annualised and not log —
    #: the IC is a *rank* correlation, so any monotonic transform of this
    #: would give the same answer, and the raw number is the readable one.
    forward_return: float
    interval: str = BASE_INTERVAL
    version: str = FORWARD_RETURN_VERSION


def _observed_at(candle_time: int, bar_seconds: int) -> datetime:
    """When the anchor bar's close became knowable.

    `Candle.time` is a **second** epoch (`app.worker.binance._parse_klines`
    floors Binance's millisecond open time), and it labels the bar's *open*.
    The measurement is anchored to the bar's close, so one interval is added:
    at the returned instant, `base_close` is a fact the product could have
    acted on. That is what makes the no-lookahead guarantee true in wall-clock
    terms and not merely in index arithmetic.
    """
    return datetime.fromtimestamp(candle_time + bar_seconds, tz=UTC)


def compute_forward_returns(
    symbol: str,
    candles: list[Candle],
    horizons: dict[str, int] | None = None,
    bar_seconds: int = BAR_SECONDS,
) -> list[ForwardReturnRow]:
    """Every forward return derivable from `candles`, and not one more.

    `candles` must be ascending by time and already have any unclosed final
    bar dropped (``app.worker.binance.drop_unclosed_candle`` does this at the
    fetch boundary). Bars whose base close is zero or negative are skipped
    rather than producing an infinite or sign-flipped return.

    Returns rows ordered by bar, then by horizon length.
    """
    horizon_map = HORIZONS if horizons is None else horizons
    if len(candles) < 2:
        return []

    closes = [c.close for c in candles]
    rows: list[ForwardReturnRow] = []

    for i, candle in enumerate(candles):
        base = closes[i]
        if base <= 0:
            continue
        for label, bars in sorted(horizon_map.items(), key=lambda kv: kv[1]):
            target = i + bars
            if target >= len(closes):
                # The future this row would describe has not happened yet.
                continue
            forward = closes[target]
            rows.append(
                ForwardReturnRow(
                    symbol=symbol,
                    observed_at=_observed_at(candle.time, bar_seconds),
                    horizon=label,
                    horizon_bars=bars,
                    base_close=base,
                    forward_close=forward,
                    forward_return=forward / base - 1.0,
                )
            )

    return rows
