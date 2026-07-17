"""Universe relative-strength scan (port of rs-scan.ts, pure parts) — "who is
actually leading or lagging BTC across the whole liquid exchange, and is
anyone mid-rotation?"

Like discovery.py this is a discovery layer outside the trading engine:
nothing here touches decision or trigger semantics, ENGINE_VERSION, or any
forward-test record. Unlike the opportunity scan it IS directional — RS
against BTC is signed — but it stays a ranking, never a verdict.

Tier 1 (every gated pair) ranks 24h RS vs BTC from one full-exchange ticker
payload; tier 2 (top/bottom `RS_ENRICH_COUNT` only) adds the exact relative.py
7d RS convention and a daily-structure trend-transition flag. The TS module's
fetchers and caches are backend concerns; the enrichment helpers here are pure
over supplied klines.
"""

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from smc.analysis import compute_pivots
from smc.discovery import DEFAULT_GATES, ScanGates, Ticker24h, percentiles
from smc.market import UNIVERSE, WORKER_UNIVERSE
from smc.mock_candles import generate_mock_candles
from smc.relative import compute_relative_read
from smc.structure import StructureTrend, compute_market_structure
from smc.trend_transition import TransitionPhase, latest_transition
from smc.types import Candle


@dataclass(slots=True)
class RsTransitionFlag:
    from_trend: StructureTrend
    to_trend: StructureTrend
    phase: TransitionPhase
    # Daily bars since the transition's latest phase advance.
    bars_ago: int


@dataclass(slots=True)
class RsRow:
    ticker: str
    # Display name when the token is in a tracked universe, else the ticker.
    name: str
    price: float
    quote_volume24h: int
    # In the curated dashboard UNIVERSE (has full snapshot coverage).
    tracked: bool
    # 24h % change minus BTC's — tier 1, present on every ranked pair.
    rs_btc24h: float
    # Cross-sectional percentile of rs_btc24h within today's gated set.
    rs_percentile24h: float
    # 168-hourly-bar RS spread (relative.py convention); None when not enriched.
    rs_btc7d: float | None = None
    # Latest daily-structure trend transition, when recent; None otherwise/not enriched.
    transition: RsTransitionFlag | None = None


@dataclass(slots=True)
class RsScan:
    source: Literal["live", "demo"]
    updated_at: str
    # Pairs that passed the gates and were RS-ranked (BTC itself excluded).
    pairs_ranked: int
    # Strongest vs BTC first (preferred = [0]).
    leaders: list[RsRow]
    # Weakest vs BTC first.
    laggards: list[RsRow]


# Rows enriched with 7d RS + transition flags, per side.
RS_ENRICH_COUNT = 15
# A transition older than this many daily bars is history, not rotation.
RS_TRANSITION_MAX_BARS = 30

_DAY_SECONDS = 86_400

_NAME_BY_TICKER = {u.ticker: u.name for u in WORKER_UNIVERSE}
_TRACKED_TICKERS = {u.ticker for u in UNIVERSE}


def _js_round(value: float) -> float:
    """JS Math.round — half toward +infinity."""
    return math.floor(value + 0.5)


def _round(value: float, digits: int = 2) -> float:
    scale = 10.0**digits
    return _js_round(value * scale) / scale


def compute_rs_rows(
    rows: list[Ticker24h],
    btc: Ticker24h,
    gates: ScanGates = DEFAULT_GATES,
) -> list[RsRow]:
    """Pure tier-1 core: gate exactly like the opportunity scan (absolute
    floors + top liquidity tier), then rank everyone's 24h change against
    BTC's. BTC is the yardstick, not a row. Sorted strongest-first with total
    tie-breaks (spread → volume → ticker).
    """
    gated = sorted(
        (
            r
            for r in rows
            if r.ticker != "BTC"
            and r.quote_volume24h >= gates.min_quote_volume24h
            and r.trades24h >= gates.min_trades24h
            and r.last_price > 0
        ),
        key=lambda r: (-r.quote_volume24h, r.ticker),
    )[: gates.liquidity_tier_size]

    spreads = [r.change_percent24h - btc.change_percent24h for r in gated]
    pcts = percentiles(spreads)

    ranked = [
        RsRow(
            ticker=row.ticker,
            name=_NAME_BY_TICKER.get(row.ticker, row.ticker),
            price=row.last_price,
            quote_volume24h=int(_js_round(row.quote_volume24h)),
            tracked=row.ticker in _TRACKED_TICKERS,
            rs_btc24h=_round(spread),
            rs_percentile24h=_round(pct, 0),
        )
        for row, spread, pct in zip(gated, spreads, pcts, strict=True)
    ]
    return sorted(ranked, key=lambda r: (-r.rs_btc24h, -r.quote_volume24h, r.ticker))


def transition_flag(daily: list[Candle]) -> RsTransitionFlag | None:
    """The latest daily transition as a rotation flag; None when stale or absent."""
    if not daily:
        return None
    transition = latest_transition(compute_market_structure(compute_pivots(daily)))
    if transition is None:
        return None
    last_time = daily[-1].time
    bars_ago = max(0, int(_js_round((last_time - transition.time) / _DAY_SECONDS)))
    if bars_ago > RS_TRANSITION_MAX_BARS:
        return None
    return RsTransitionFlag(
        from_trend=transition.from_trend,
        to_trend=transition.to_trend,
        phase=transition.phase,
        bars_ago=bars_ago,
    )


def build_demo_rs_scan() -> RsScan:
    """Deterministic offline fallback over the worker universe, mirroring
    build_demo_scan's stance: gates lifted (synthetic volumes aren't exchange
    units), enrichment computed from the same mock series.
    """
    btc_hourly = generate_mock_candles("BTC", "1H")
    btc_day = btc_hourly[-24:]
    btc_change = (
        (btc_day[-1].close - btc_day[0].open) / btc_day[0].open * 100
        if btc_day[0].open > 0
        else 0.0
    )

    rows: list[Ticker24h] = []
    for entry in WORKER_UNIVERSE:
        if entry.ticker == "BTC":
            continue
        hourly = generate_mock_candles(entry.ticker, "1H")
        day = hourly[-24:]
        last = day[-1]
        quote_volume24h = sum(c.volume * c.close for c in day)
        rows.append(
            Ticker24h(
                ticker=entry.ticker,
                last_price=last.close,
                change_percent24h=(
                    (last.close - day[0].open) / day[0].open * 100 if day[0].open > 0 else 0.0
                ),
                high_price=max(c.high for c in day),
                low_price=min(c.low for c in day),
                weighted_avg_price=sum(c.close for c in day) / len(day),
                quote_volume24h=quote_volume24h,
                trades24h=max(1, int(_js_round(quote_volume24h / 250))),
            )
        )
    btc_row = Ticker24h(
        ticker="BTC",
        last_price=btc_hourly[-1].close,
        change_percent24h=btc_change,
        high_price=0,
        low_price=0,
        weighted_avg_price=0,
        quote_volume24h=0,
        trades24h=0,
    )

    ranked = compute_rs_rows(
        rows,
        btc_row,
        ScanGates(min_quote_volume24h=0, min_trades24h=0, liquidity_tier_size=len(rows)),
    )
    for side in (ranked[:RS_ENRICH_COUNT], ranked[-RS_ENRICH_COUNT:]):
        for row in side:
            row.rs_btc7d = compute_relative_read(
                generate_mock_candles(row.ticker, "1H"), btc_hourly
            ).rs_btc7d
            row.transition = transition_flag(generate_mock_candles(row.ticker, "1D"))

    return RsScan(
        source="demo",
        updated_at=datetime.now(UTC).isoformat(),
        pairs_ranked=len(ranked),
        leaders=ranked[:RS_ENRICH_COUNT],
        laggards=list(reversed(ranked[-RS_ENRICH_COUNT:])),
    )
