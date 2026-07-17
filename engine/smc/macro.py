"""Macro (TradFi) context read models (port of macro.ts, pure parts).

S&P 500 / Nasdaq 100 / Dollar Index / Gold instruments plus the BTC↔NDX
correlation regime. The TS module's FRED/Binance fetchers and cache are
backend concerns; the engine turns daily close series it is given into
instruments and correlation reads. `FRED_SERIES` stays here as shared config
so every fetcher asks for the same series.
"""

import math
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Literal

MacroInstrumentId = Literal["spx", "ndx", "dxy", "gold"]
CorrelationRegime = Literal["coupled", "decoupled", "inverse"]

MACRO_INSTRUMENT_IDS: tuple[MacroInstrumentId, ...] = ("spx", "ndx", "dxy", "gold")


@dataclass(slots=True)
class MacroInstrument:
    id: MacroInstrumentId
    label: str
    last: float
    change_percent: float
    spark: list[float]


@dataclass(slots=True)
class MacroSnapshot:
    instruments: list[MacroInstrument]
    # Pearson correlation of BTC vs Nasdaq 100 daily returns, ~30 shared sessions.
    btc_ndx_correlation: float | None
    correlation_regime: CorrelationRegime | None
    source: Literal["live", "demo"]
    updated_at: str


@dataclass(slots=True)
class SeriesPoint:
    date: str
    close: float


INSTRUMENT_LABELS: dict[MacroInstrumentId, str] = {
    "spx": "S&P 500",
    "ndx": "Nasdaq 100",
    "dxy": "Dollar Index",
    "gold": "Gold",
}

# FRED publishes these daily with a short lag and no API key; Yahoo/Stooq block
# datacenter IPs. Gold rides the Binance pipeline via PAXG (tokenized gold,
# tracks spot ~1:1) so it stays live even when FRED lags.
FRED_SERIES: dict[str, str] = {
    "spx": "SP500",
    "ndx": "NASDAQ100",
    "dxy": "DTWEXBGS",
}

SPARK_POINTS = 30
CORRELATION_SESSIONS = 30


def _to_fixed2(value: float) -> float:
    """Number(x.toFixed(2)) — half toward +infinity is close enough off the decision path."""
    return math.floor(value * 100 + 0.5) / 100


def to_instrument(id_: MacroInstrumentId, series: list[SeriesPoint]) -> MacroInstrument:
    closes = [p.close for p in series]
    last = closes[-1] if closes else 0.0
    prev = closes[-2] if len(closes) >= 2 else last
    return MacroInstrument(
        id=id_,
        label=INSTRUMENT_LABELS[id_],
        last=_to_fixed2(last),
        change_percent=_to_fixed2((last - prev) / prev * 100) if prev != 0 else 0.0,
        spark=[_to_fixed2(v) for v in closes[-SPARK_POINTS:]],
    )


def _pearson(a: list[float], b: list[float]) -> float | None:
    n = min(len(a), len(b))
    if n < 10:
        return None
    mean_a = sum(a[:n]) / n
    mean_b = sum(b[:n]) / n
    cov = 0.0
    var_a = 0.0
    var_b = 0.0
    for x, y in zip(a[:n], b[:n], strict=True):
        da = x - mean_a
        db = y - mean_b
        cov += da * db
        var_a += da * da
        var_b += db * db
    if var_a == 0 or var_b == 0:
        return None
    return cov / math.sqrt(var_a * var_b)


def compute_btc_ndx_correlation(btc: list[SeriesPoint], ndx: list[SeriesPoint]) -> float | None:
    """Correlation of daily returns over the last ~30 sessions both markets traded.

    Aligning on shared dates drops crypto's weekends so a closed stock market
    never reads as divergence.
    """
    btc_by_date = {p.date: p.close for p in btc}
    shared = [p for p in ndx if p.date in btc_by_date][-(CORRELATION_SESSIONS + 1) :]
    if len(shared) < 11:
        return None

    btc_returns: list[float] = []
    ndx_returns: list[float] = []
    for i in range(1, len(shared)):
        prev_btc = btc_by_date[shared[i - 1].date]
        cur_btc = btc_by_date[shared[i].date]
        if prev_btc == 0 or shared[i - 1].close == 0:
            continue
        btc_returns.append(cur_btc / prev_btc - 1)
        ndx_returns.append(shared[i].close / shared[i - 1].close - 1)
    value = _pearson(btc_returns, ndx_returns)
    return None if value is None else _to_fixed2(value)


def correlation_regime_of(correlation: float | None) -> CorrelationRegime | None:
    if correlation is None:
        return None
    if correlation >= 0.4:
        return "coupled"
    if correlation <= -0.3:
        return "inverse"
    return "decoupled"


# --- deterministic demo fallback (same philosophy as mock_candles) ---

_DEMO_BASE: dict[MacroInstrumentId, tuple[float, float]] = {
    "spx": (7480, 0.008),
    "ndx": (29500, 0.012),
    "dxy": (121, 0.003),
    "gold": (4170, 0.009),
}

_DEMO_END = date(2026, 7, 5)


def _demo_series(id_: str, base: float, volatility: float) -> list[SeriesPoint]:
    seed = 0
    for ch in id_:
        seed = (seed * 31 + ord(ch)) & 0xFFFFFFFF

    def rand() -> float:
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed / 4294967296

    close = base * (0.97 + rand() * 0.06)
    out: list[SeriesPoint] = []
    for i in range(60):
        close *= 1 + (rand() - 0.49) * volatility
        out.append(SeriesPoint(date=(_DEMO_END - timedelta(days=59 - i)).isoformat(), close=close))
    return out


def build_demo_macro_snapshot() -> MacroSnapshot:
    series = {
        id_: _demo_series(id_, _DEMO_BASE[id_][0], _DEMO_BASE[id_][1])
        for id_ in MACRO_INSTRUMENT_IDS
    }
    btc_demo = _demo_series("btc", 108_000, 0.02)
    correlation = compute_btc_ndx_correlation(btc_demo, series["ndx"])
    return MacroSnapshot(
        instruments=[to_instrument(id_, series[id_]) for id_ in MACRO_INSTRUMENT_IDS],
        btc_ndx_correlation=correlation,
        correlation_regime=correlation_regime_of(correlation),
        source="demo",
        updated_at=datetime.now(UTC).isoformat(),
    )
