"""In-memory market state store + rolling-window aggregator for the radar.

The hot path never touches Postgres and never issues a per-symbol request. One
all-market websocket frame (`!ticker@arr`, ~1/s) updates every symbol at once;
this module packs those frames into fixed-length per-symbol sample buffers and
derives the short-window metrics the detector reads.

## What a frame actually gives us

Binance's futures 24h ticker carries, per symbol: last price (`c`), the *24h
rolling* traded quote volume (`q`), the *24h rolling* trade count (`n`), and
the 24h change percent (`P`). It does not carry a 1m or 3m window — so we build
those ourselves:

* **Price windows** are exact: the buffer holds the observed price series, and
  `change_3m_pct` is measured against the sample nearest 3 minutes back.
* **Volume/trade windows** are differences of the 24h cumulative counters:
  `volume(W) ≈ q(now) - q(now - W)`. That difference also subtracts whatever
  traded in the same-length window 24 hours ago, so it is an approximation, not
  a true window sum. It is used *only* as the numerator of a ratio whose
  denominator (`baseline`) is computed the exact same way over a longer span —
  the roll-off bias is present in both terms and largely cancels. Relative
  volume is therefore meaningful even though the absolute window volume is not
  exact, and the API labels the absolute figure as approximate.

## Baselines and cold start

The relative-volume/trade-rate baseline is the observed per-minute rate over
`BASELINE_SECONDS`, **excluding the most recent `BASELINE_EXCLUDE_SECONDS`** so
a live burst cannot inflate the baseline it is being measured against. Until
enough baseline samples exist (process just started), the store falls back to
the 24h average implied by the frame itself (`q / 1440` per minute) — available
on the very first frame, so the radar is never blind, only less precise. Price
windows have no such prior: they report `None` until the buffer is deep enough,
and `warming_up` stays True until the 3m window is available.

Volatility expansion uses a per-minute range EWMA maintained incrementally
(O(1) per sample) rather than a rescan, and is expressed as the current 1m
range over that baseline.

Buffers are `array('d')` rather than lists of tuples: at ~600 perps x 1800
samples that is tens of MB instead of hundreds.
"""

from __future__ import annotations

import bisect
import math
from array import array
from dataclasses import dataclass, field

from smc.momentum import MomentumConfig, WindowMetrics
from smc.types import Candle

from app.momentum import config as cfg
from app.worker.binance import canonical_perp_ticker

# `WindowMetrics` is re-exported so the scanner reads its inputs from the layer
# that produces them rather than reaching past it into the engine.
__all__ = [
    "MarketStateStore",
    "SymbolState",
    "TickerFrame",
    "WindowMetrics",
    "parse_ticker_array",
    "parse_ticker_frame",
]

# Baseline excludes the most recent 3 minutes — the same span as the longest
# window the volume gates read, so a firing candidate never sets its own bar.
BASELINE_EXCLUDE_SECONDS = 180.0
# Per-minute range EWMA smoothing (~15-minute effective memory).
RANGE_EWMA_ALPHA = 2.0 / (15.0 + 1.0)
MINUTES_PER_DAY = 1440.0
# A sample this much older than the requested window still counts as "the
# sample at W ago" — the stream is ~1/s but frames drop.
WINDOW_TOLERANCE_SECONDS = 20.0

_EPS = 1e-9


@dataclass(frozen=True, slots=True)
class TickerFrame:
    """One symbol's row out of a `!ticker@arr` frame, already parsed."""

    symbol: str
    price: float
    quote_volume_24h: float
    trades_24h: float
    change_24h_pct: float
    event_ts: float


def parse_ticker_frame(row: object) -> TickerFrame | None:
    """Parses one `24hrTicker` row. Returns None for anything malformed, not
    USDT-quoted, or below the liquidity floor — the failure convention the rest
    of the Binance plane uses (`app.worker.binance`): degrade, never raise."""
    if not isinstance(row, dict):
        return None
    pair = row.get("s")
    if not isinstance(pair, str) or not pair.endswith(cfg.QUOTE_SUFFIX):
        return None
    try:
        price = float(row["c"])
        quote_volume = float(row["q"])
        trades = float(row["n"])
        change_pct = float(row["P"])
        event_ts = float(row.get("E", 0)) / 1000.0
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (price, quote_volume, trades, change_pct)):
        return None
    if price <= 0 or quote_volume < cfg.MIN_QUOTE_VOLUME_24H:
        return None
    base = pair[: -len(cfg.QUOTE_SUFFIX)]
    if not base:
        return None
    return TickerFrame(
        symbol=canonical_perp_ticker(base),
        price=price,
        quote_volume_24h=quote_volume,
        trades_24h=trades,
        change_24h_pct=change_pct,
        event_ts=event_ts,
    )


def parse_ticker_array(payload: object) -> list[TickerFrame]:
    if not isinstance(payload, list):
        return []
    out: list[TickerFrame] = []
    for row in payload:
        frame = parse_ticker_frame(row)
        if frame is not None:
            out.append(frame)
    return out


@dataclass(slots=True)
class SymbolState:
    """One symbol's rolling buffers. Prices are the exchange's own quote (a
    `1000PEPE`-style base keeps its multiplied price) — every metric derived
    here is a ratio or a percentage, so the multiplier cancels and only the
    ticker name needs canonicalizing."""

    symbol: str
    ts: array[float] = field(default_factory=lambda: array("d"))
    price: array[float] = field(default_factory=lambda: array("d"))
    quote_volume: array[float] = field(default_factory=lambda: array("d"))
    trades: array[float] = field(default_factory=lambda: array("d"))

    change_24h_pct: float = 0.0
    quote_volume_24h: float = 0.0
    last_meaningful_ts: float = 0.0

    # Incremental per-minute range EWMA (volatility baseline).
    range_ewma_pct: float = 0.0
    _bucket_start: float = 0.0
    _bucket_high: float = 0.0
    _bucket_low: float = 0.0

    def ingest(self, frame: TickerFrame, now: float) -> None:
        """Appends a sample, honouring the minimum sample interval, and folds
        the frame into the per-minute range bucket."""
        if self.ts and now - self.ts[-1] < cfg.SAMPLE_MIN_INTERVAL_SECONDS:
            self._update_bucket(frame.price, now)
            return
        self.ts.append(now)
        self.price.append(frame.price)
        self.quote_volume.append(frame.quote_volume_24h)
        self.trades.append(frame.trades_24h)
        self.change_24h_pct = frame.change_24h_pct
        self.quote_volume_24h = frame.quote_volume_24h
        self._update_bucket(frame.price, now)
        self._trim(now)

    def _update_bucket(self, price: float, now: float) -> None:
        if self._bucket_start <= 0.0:
            self._bucket_start = now
            self._bucket_high = price
            self._bucket_low = price
            return
        self._bucket_high = max(self._bucket_high, price)
        self._bucket_low = min(self._bucket_low, price)
        if now - self._bucket_start < 60.0:
            return
        mid = (self._bucket_high + self._bucket_low) / 2.0
        range_pct = (self._bucket_high - self._bucket_low) / mid * 100.0 if mid > _EPS else 0.0
        self.range_ewma_pct = (
            range_pct
            if self.range_ewma_pct <= 0.0
            else RANGE_EWMA_ALPHA * range_pct + (1.0 - RANGE_EWMA_ALPHA) * self.range_ewma_pct
        )
        self._bucket_start = now
        self._bucket_high = price
        self._bucket_low = price

    def _trim(self, now: float) -> None:
        """Drops samples past the retention horizon. Amortized: only slices
        when a decent chunk has aged out, since `del arr[:k]` is O(n)."""
        cutoff = now - cfg.HISTORY_SECONDS
        if not self.ts or self.ts[0] >= cutoff:
            return
        cut = bisect.bisect_left(self.ts, cutoff)
        # Amortize: only pay the O(n) slice once a fifth of the buffer has aged
        # out, so the trim cost is independent of the feed's tick rate.
        if cut < max(50, len(self.ts) // 5):
            return
        del self.ts[:cut]
        del self.price[:cut]
        del self.quote_volume[:cut]
        del self.trades[:cut]

    # ── window helpers ──────────────────────────────────────────────────────

    def _index_at(self, target_ts: float) -> int | None:
        """Index of the newest sample at or before `target_ts`, or None when
        the buffer does not reach that far back (within tolerance)."""
        if not self.ts:
            return None
        if self.ts[0] > target_ts + WINDOW_TOLERANCE_SECONDS:
            return None
        index = bisect.bisect_right(self.ts, target_ts) - 1
        return index if index >= 0 else 0

    def _change_pct(self, now: float, seconds: float) -> float | None:
        index = self._index_at(now - seconds)
        if index is None or not self.price:
            return None
        past: float = self.price[index]
        if past <= _EPS:
            return None
        return (self.price[-1] - past) / past * 100.0

    def _counter_delta(self, now: float, seconds: float) -> tuple[float, float] | None:
        """(quote-volume, trade-count) accumulated over the window, as a
        difference of the 24h rolling counters. See the module docstring on why
        that approximation is sound for ratios."""
        index = self._index_at(now - seconds)
        if index is None or not self.quote_volume:
            return None
        volume = max(0.0, self.quote_volume[-1] - self.quote_volume[index])
        count = max(0.0, self.trades[-1] - self.trades[index])
        return volume, count

    def _baseline_per_minute(self, now: float) -> tuple[float, float]:
        """(quote-volume/min, trades/min) baseline. Observed when the buffer is
        deep enough, otherwise the 24h-average prior from the frame itself."""
        prior_volume = self.quote_volume_24h / MINUTES_PER_DAY
        prior_trades = (self.trades[-1] / MINUTES_PER_DAY) if self.trades else 0.0

        end_ts = now - BASELINE_EXCLUDE_SECONDS
        start_ts = end_ts - cfg.BASELINE_SECONDS
        start = self._index_at(start_ts)
        end = self._index_at(end_ts)
        if start is None or end is None or end - start < cfg.BASELINE_MIN_SAMPLES:
            return prior_volume, prior_trades

        span_seconds = self.ts[end] - self.ts[start]
        if span_seconds < cfg.BASELINE_MIN_SPAN_SECONDS:
            return prior_volume, prior_trades
        span_minutes = span_seconds / 60.0
        volume = max(0.0, self.quote_volume[end] - self.quote_volume[start]) / span_minutes
        trades = max(0.0, self.trades[end] - self.trades[start]) / span_minutes
        # A genuinely dead baseline would divide by ~0 and manufacture a huge
        # relative volume; fall back to the prior rather than print nonsense.
        if volume <= _EPS or trades <= _EPS:
            return prior_volume, prior_trades
        return volume, trades

    def _extremes(self, now: float, seconds: float) -> tuple[float, float]:
        index = self._index_at(now - seconds)
        if index is None:
            index = 0
        window = self.price[index:]
        if not window:
            last = self.price[-1] if self.price else 0.0
            return last, last
        return max(window), min(window)

    def micro_candles(self, now: float, minutes: int = 40) -> list[Candle]:
        """Rebuilds closed 1-minute candles from the tick buffer.

        The feed carries no klines, but it carries a ~1/s price series, which
        is enough to fold into minute bars for a *micro* structure read (see
        `smc.micro_structure`). Only closed minutes are returned — a forming
        bar would make the 1m structure flip back and forth inside the minute,
        which is exactly the reactivity this whole revision removes.

        Volume comes from the 24h counter difference across the bucket, the
        same approximation the relative-volume windows use; nothing structural
        reads it.
        """
        if not self.ts:
            return []
        cutoff = now - minutes * 60.0
        start = self._index_at(cutoff)
        if start is None:
            start = 0
        current_minute = math.floor(now / 60.0)

        candles: list[Candle] = []
        bucket = -1
        for index in range(start, len(self.ts)):
            minute = math.floor(self.ts[index] / 60.0)
            if minute >= current_minute:
                break
            price = self.price[index]
            if minute != bucket:
                bucket = minute
                candles.append(
                    Candle(
                        time=minute * 60,
                        open=price,
                        high=price,
                        low=price,
                        close=price,
                        volume=0.0,
                    )
                )
                continue
            candle = candles[-1]
            candle.high = max(candle.high, price)
            candle.low = min(candle.low, price)
            candle.close = price

        if candles and self.quote_volume:
            # One pass for volume: the counter delta across each bucket.
            for candle in candles:
                begin = self._index_at(candle.time)
                end = self._index_at(candle.time + 60.0)
                if begin is None or end is None or end <= begin:
                    continue
                candle.volume = max(0.0, self.quote_volume[end] - self.quote_volume[begin])
        return candles

    # ── public read ─────────────────────────────────────────────────────────

    def metrics(self, now: float, detector: MomentumConfig) -> WindowMetrics | None:
        """Aggregates the buffer into one `WindowMetrics`. Returns None when
        the symbol has no samples at all.

        Side effect by design: `last_meaningful_ts` is advanced here, because
        "meaningful" is defined in terms of the very windows this method
        computes. Staleness is measured against tape activity, not tick
        arrival — a symbol printing flat 1s ticks forever is stale.
        """
        if not self.ts or not self.price:
            return None

        change_1m = self._change_pct(now, 60.0)
        change_3m = self._change_pct(now, 180.0)
        change_5m = self._change_pct(now, 300.0)
        change_15m = self._change_pct(now, 900.0)

        baseline_volume, baseline_trades = self._baseline_per_minute(now)

        def _rvol(seconds: float) -> float | None:
            delta = self._counter_delta(now, seconds)
            if delta is None or baseline_volume <= _EPS:
                return None
            return delta[0] / (baseline_volume * (seconds / 60.0))

        window_1m = self._counter_delta(now, 60.0) or (0.0, 0.0)
        volume_1m, trades_1m = window_1m
        rvol_1m = _rvol(60.0)
        rvol_3m = _rvol(180.0)
        rvol_5m = _rvol(300.0)
        # The intraday mode works off 5m/15m, so the 15m window is carried too.
        rvol_15m = _rvol(900.0)

        trade_rate_mult = (
            trades_1m / baseline_trades if baseline_trades > _EPS and trades_1m > 0 else None
        )

        high_5m, low_5m = self._extremes(now, 300.0)
        high_1m, low_1m = self._extremes(now, 60.0)
        mid_1m = (high_1m + low_1m) / 2.0
        range_1m_pct = (high_1m - low_1m) / mid_1m * 100.0 if mid_1m > _EPS else 0.0
        range_expansion = (
            range_1m_pct / self.range_ewma_pct if self.range_ewma_pct > _EPS else None
        )

        meaningful = (change_1m is not None and abs(change_1m) >= detector.meaningful_move_pct) or (
            rvol_1m is not None and rvol_1m >= detector.meaningful_rvol
        )
        if meaningful:
            self.last_meaningful_ts = now

        return WindowMetrics(
            symbol=self.symbol,
            ts=now,
            price=self.price[-1],
            change_1m_pct=change_1m,
            change_3m_pct=change_3m,
            change_5m_pct=change_5m,
            change_15m_pct=change_15m,
            rvol_1m=rvol_1m,
            rvol_3m=rvol_3m,
            rvol_5m=rvol_5m,
            rvol_15m=rvol_15m,
            trade_rate_mult=trade_rate_mult,
            volatility_1m_pct=self.range_ewma_pct if self.range_ewma_pct > _EPS else None,
            range_expansion=range_expansion,
            window_high=high_5m,
            window_low=low_5m,
            quote_volume_1m=volume_1m,
            trades_1m=trades_1m,
            quote_volume_24h=self.quote_volume_24h,
            change_24h_pct=self.change_24h_pct,
            last_meaningful_ts=self.last_meaningful_ts,
            warming_up=change_3m is None or rvol_1m is None,
        )


class MarketStateStore:
    """Every tracked symbol's rolling state. Single-writer (the ingestor task)
    and read from the scanner task on the same event loop, so no locking is
    needed — but nothing here may block, or it would stall ingestion."""

    def __init__(self, detector: MomentumConfig | None = None) -> None:
        self._symbols: dict[str, SymbolState] = {}
        self._detector = detector if detector is not None else cfg.load_detector_config()
        self.last_frame_ts: float = 0.0
        self.frames_ingested: int = 0

    @property
    def detector(self) -> MomentumConfig:
        return self._detector

    def __len__(self) -> int:
        return len(self._symbols)

    def symbols(self) -> list[str]:
        return list(self._symbols)

    def get(self, symbol: str) -> SymbolState | None:
        return self._symbols.get(symbol)

    def ingest_batch(self, frames: list[TickerFrame], now: float) -> None:
        for frame in frames:
            state = self._symbols.get(frame.symbol)
            if state is None:
                state = SymbolState(symbol=frame.symbol)
                self._symbols[frame.symbol] = state
            state.ingest(frame, now)
        self.last_frame_ts = now
        self.frames_ingested += 1

    def micro_candles(self, symbol: str, now: float, minutes: int = 40) -> list[Candle]:
        """Closed 1m candles for one symbol, or `[]` when it is not tracked.

        Deliberately per-symbol and on demand: the scanner only asks for the
        handful of symbols that currently have a tracker, so this never runs
        across the whole universe on a tick.
        """
        state = self._symbols.get(symbol)
        return state.micro_candles(now, minutes) if state is not None else []

    def snapshot_metrics(self, now: float) -> list[WindowMetrics]:
        out: list[WindowMetrics] = []
        for state in self._symbols.values():
            metrics = state.metrics(now, self._detector)
            if metrics is not None:
                out.append(metrics)
        return out
