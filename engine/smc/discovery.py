"""Market-opportunity discovery — "which tokens are worth scanning right now?"
(port of discovery.ts, pure parts).

Ranks EVERY liquid Binance USDT spot pair (not just the curated UNIVERSE) by a
blend of 24h volatility, liquidity, and trade activity, all read from one
full-exchange `/ticker/24hr` payload. This is a discovery layer, not a signal:
it says "there is action here", never "long/short". It is deliberately outside
the trading engine — nothing here touches decision or trigger semantics,
ENGINE_VERSION, or any forward-test record.

Thin pairs are handled three ways: a hard absolute floor removes dust pairs
entirely; only the exchange's top liquidity tier (most-traded pairs by USDT
turnover) is ranked at all, which keeps the candidate set honest in hot and
quiet tapes alike; and volatility credit inside the score is damped by
liquidity rank, so a barely-gated pair printing a 100% range still cannot
outrank a deep pair in a real expansion.

The TS module's fetchers and caches are backend concerns; the engine parses,
gates, and ranks payloads it is given.
"""

import asyncio
import math
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from smc.market import UNIVERSE, WORKER_UNIVERSE
from smc.mock_candles import generate_mock_candles
from smc.spike import SpikeEvent, detect_spike
from smc.types import Candle


@dataclass(slots=True)
class Ticker24h:
    """One normalized row of Binance's 24h rolling ticker."""

    # Base asset, e.g. "SOL".
    ticker: str
    last_price: float
    change_percent24h: float
    high_price: float
    low_price: float
    weighted_avg_price: float
    # 24h turnover in USDT.
    quote_volume24h: float
    # Number of trades in the window.
    trades24h: float


@dataclass(slots=True)
class MarketOpportunity:
    ticker: str
    # Display name when the token is in a tracked universe, else the ticker.
    name: str
    price: float
    change24h: float
    # 24h high-low span as % of the volume-weighted average price.
    range_percent24h: float
    quote_volume24h: int
    trades24h: int
    # 0-100 blended scan score.
    score: float
    volatility_percentile: float
    liquidity_percentile: float
    activity_percentile: float
    # In the curated dashboard UNIVERSE (has full snapshot coverage).
    tracked: bool
    # Human line for "why is this worth scanning" — never directional.
    reason: str
    # Set when this pair just printed a vertical-spike-and-reject on the short TF.
    spike: SpikeEvent | None = None


@dataclass(slots=True)
class SpikeHit:
    """A pair currently showing a vertical-spike-and-reject — a discovery flag, not a call."""

    ticker: str
    name: str
    price: float
    tracked: bool
    spike: SpikeEvent


@dataclass(slots=True)
class OpportunityScan:
    source: Literal["live", "demo"]
    updated_at: str
    # USDT pairs seen on the exchange before any filtering.
    pairs_seen: int
    # Pairs that passed the liquidity/activity gates and were ranked.
    pairs_ranked: int
    # Ranked candidates, best first (preferred = [0]).
    opportunities: list[MarketOpportunity]
    # Pairs across the whole liquidity tier currently in a spike-and-reject,
    # heaviest volume first.
    spikes: list[SpikeHit]


@dataclass(slots=True)
class ScanGates:
    # Minimum 24h USDT turnover — below this a pair is not a candidate at all.
    min_quote_volume24h: float
    # Minimum 24h trade count — screens out wash-y low-participation pairs.
    min_trades24h: float
    # After the absolute floors, only the N most liquid survivors are ranked.
    # This adapts the gate to the tape: on a quiet exchange the floor does the
    # work; on a hot one the tier keeps "liquid" meaning top-of-exchange.
    liquidity_tier_size: int


DEFAULT_GATES = ScanGates(
    min_quote_volume24h=5_000_000,
    min_trades24h=10_000,
    liquidity_tier_size=100,
)

# Volatility leads (it is what makes a pair worth *scanning today*), but
# liquidity + activity together outweigh it so movement alone never wins.
SCORE_WEIGHT_VOLATILITY = 0.45
SCORE_WEIGHT_LIQUIDITY = 0.3
SCORE_WEIGHT_ACTIVITY = 0.25

TOP_N = 12

# Quote-stable, fiat, and pegged/wrapped bases: their "volatility" is either
# ~zero or an artifact, and scanning them is never actionable.
_EXCLUDED_BASES = {
    "USDC",
    "FDUSD",
    "TUSD",
    "DAI",
    "USDP",
    "USDE",
    "USD1",
    "PYUSD",
    "BFUSD",
    "XUSD",
    "EUR",
    "EURI",
    "AEUR",
    "GBP",
    "TRY",
    "BRL",
    "ARS",
    "COP",
    "UAH",
    "PLN",
    "RON",
    "CZK",
    "MXN",
    "ZAR",
    "JPY",
    "WBTC",
    "WBETH",
    "BETH",
    "PAXG",
    "XAUT",
}

# Legacy leveraged tokens (BTCUP, ETHDOWN, EOSBULL...). The >=3-char prefix
# keeps real tickers like JUP from matching.
_LEVERAGED_BASE_RE = re.compile(r"^.{3,}(UP|DOWN|BULL|BEAR)$")


def _is_scannable_base(base: str) -> bool:
    return len(base) > 0 and base not in _EXCLUDED_BASES and _LEVERAGED_BASE_RE.match(base) is None


def _to_finite_number(value: object) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, int | float):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            n = float(value)
        except ValueError:
            return None
        return n if math.isfinite(n) else None
    return None


def parse_ticker24h_all(payload: object) -> list[Ticker24h]:
    """Normalizes the raw `/ticker/24hr` array to USDT-pair rows, dropping
    non-USDT quotes, stables/fiat/wrapped/leveraged bases, and malformed rows.
    """
    if not isinstance(payload, list):
        return []
    rows: list[Ticker24h] = []
    for raw in payload:
        if not isinstance(raw, dict):
            continue
        symbol = raw.get("symbol")
        if not isinstance(symbol, str) or not symbol.endswith("USDT"):
            continue
        base = symbol[:-4]
        if not _is_scannable_base(base):
            continue

        last_price = _to_finite_number(raw.get("lastPrice"))
        change_percent24h = _to_finite_number(raw.get("priceChangePercent"))
        high_price = _to_finite_number(raw.get("highPrice"))
        low_price = _to_finite_number(raw.get("lowPrice"))
        weighted_avg_price = _to_finite_number(raw.get("weightedAvgPrice"))
        quote_volume24h = _to_finite_number(raw.get("quoteVolume"))
        trades24h = _to_finite_number(raw.get("count"))
        if (
            last_price is None
            or change_percent24h is None
            or high_price is None
            or low_price is None
            or weighted_avg_price is None
            or quote_volume24h is None
            or trades24h is None
        ):
            continue
        rows.append(
            Ticker24h(
                ticker=base,
                last_price=last_price,
                change_percent24h=change_percent24h,
                high_price=high_price,
                low_price=low_price,
                weighted_avg_price=weighted_avg_price,
                quote_volume24h=quote_volume24h,
                trades24h=trades24h,
            )
        )
    return rows


def _js_round(value: float) -> float:
    """JS Math.round — half toward +infinity."""
    return math.floor(value + 0.5)


def _round(value: float, digits: int = 0) -> float:
    scale = 10.0**digits
    return _js_round(value * scale) / scale


def _range_percent(row: Ticker24h) -> float:
    anchor = row.weighted_avg_price if row.weighted_avg_price > 0 else row.last_price
    if anchor <= 0 or row.high_price < row.low_price:
        return 0.0
    return (row.high_price - row.low_price) / anchor * 100


def percentiles(values: list[float]) -> list[float]:
    """Rank-based percentile (0-100) of each value within its own set."""
    n = len(values)
    if n <= 1:
        return [100.0 for _ in values]
    return [sum(1 for other in values if other < v) / (n - 1) * 100 for v in values]


_NAME_BY_TICKER = {u.ticker: u.name for u in WORKER_UNIVERSE}
_TRACKED_TICKERS = {u.ticker for u in UNIVERSE}


def _build_reason(vol_pct: float, liq_pct: float, act_pct: float) -> str:
    parts: list[str] = []
    if vol_pct >= 85:
        parts.append("outsized 24h range")
    elif vol_pct >= 60:
        parts.append("elevated 24h range")
    if liq_pct >= 85:
        parts.append("deep liquidity")
    elif liq_pct >= 60:
        parts.append("solid liquidity")
    if act_pct >= 85:
        parts.append("very heavy trade flow")
    elif act_pct >= 60:
        parts.append("busy tape")
    text = " · ".join(parts) if parts else "balanced liquidity and movement"
    return text[0].upper() + text[1:]


def score_opportunities(
    rows: list[Ticker24h],
    gates: ScanGates = DEFAULT_GATES,
) -> list[MarketOpportunity]:
    """Pure, deterministic ranking of gated candidates.

    Percentile scoring is self-calibrating: "volatile" means volatile relative
    to today's liquid pairs, so the list stays meaningful in quiet and wild
    tapes alike. Returns the FULL ranked list — callers slice for display.
    """
    gated = sorted(
        (
            r
            for r in rows
            if r.quote_volume24h >= gates.min_quote_volume24h
            and r.trades24h >= gates.min_trades24h
            and r.last_price > 0
        ),
        key=lambda r: (-r.quote_volume24h, r.ticker),
    )[: gates.liquidity_tier_size]

    vol_pcts = percentiles([_range_percent(r) for r in gated])
    # Log-scaled so a $2B pair doesn't flatten every mid-cap to zero.
    liq_pcts = percentiles([math.log10(max(1, r.quote_volume24h)) for r in gated])
    act_pcts = percentiles([math.log10(max(1, r.trades24h)) for r in gated])

    scored: list[MarketOpportunity] = []
    for row, vol_pct, liq_pct, act_pct in zip(gated, vol_pcts, liq_pcts, act_pcts, strict=True):
        # Volatility credit scales with liquidity rank (x0.5 at the bottom of
        # the tier, x1 at the top): a wild range on a barely-gated pair earns
        # half what the same range earns on a deep one.
        damped_vol = vol_pct * (0.5 + liq_pct / 200)
        score = (
            SCORE_WEIGHT_VOLATILITY * damped_vol
            + SCORE_WEIGHT_LIQUIDITY * liq_pct
            + SCORE_WEIGHT_ACTIVITY * act_pct
        )
        scored.append(
            MarketOpportunity(
                ticker=row.ticker,
                name=_NAME_BY_TICKER.get(row.ticker, row.ticker),
                price=row.last_price,
                change24h=_round(row.change_percent24h, 2),
                range_percent24h=_round(_range_percent(row), 2),
                quote_volume24h=int(_js_round(row.quote_volume24h)),
                trades24h=int(_js_round(row.trades24h)),
                score=_round(score, 1),
                volatility_percentile=_round(vol_pct),
                liquidity_percentile=_round(liq_pct),
                activity_percentile=_round(act_pct),
                tracked=row.ticker in _TRACKED_TICKERS,
                reason=_build_reason(vol_pct, liq_pct, act_pct),
            )
        )

    return sorted(scored, key=lambda o: (-o.score, -o.quote_volume24h, o.ticker))


def build_demo_scan() -> OpportunityScan:
    """Deterministic offline fallback built from the same mock candles the rest
    of the app degrades to. Gates are lifted because synthetic volumes aren't
    in real-exchange units — the demo exists to exercise the surface, not the
    gate.
    """
    rows: list[Ticker24h] = []
    for entry in WORKER_UNIVERSE:
        day = generate_mock_candles(entry.ticker, "1H")[-24:]
        last = day[-1]
        first = day[0]
        quote_volume24h = sum(c.volume * c.close for c in day)
        rows.append(
            Ticker24h(
                ticker=entry.ticker,
                last_price=last.close,
                change_percent24h=(
                    (last.close - first.open) / first.open * 100 if first.open > 0 else 0.0
                ),
                high_price=max(c.high for c in day),
                low_price=min(c.low for c in day),
                weighted_avg_price=sum(c.close for c in day) / len(day),
                quote_volume24h=quote_volume24h,
                trades24h=max(1, int(_js_round(quote_volume24h / 250))),
            )
        )
    opportunities = score_opportunities(
        rows,
        ScanGates(min_quote_volume24h=0, min_trades24h=0, liquidity_tier_size=len(rows)),
    )
    return OpportunityScan(
        source="demo",
        updated_at=datetime.now(UTC).isoformat(),
        pairs_seen=len(rows),
        pairs_ranked=len(rows),
        opportunities=opportunities[:TOP_N],
        # Spike detection needs real short-TF klines; the offline build never
        # fabricates them, so the demo surface simply carries no spikes.
        spikes=[],
    )


# Injectable so callers can drive detection without touching the network.
KlineFetcher = Callable[[str], Awaitable[list[Candle]]]


async def scan_spikes(
    candidates: list[MarketOpportunity],
    fetch_klines: KlineFetcher,
) -> list[SpikeHit]:
    """Runs the pure detector over every candidate's short-TF klines and
    returns the hits, heaviest volume first. Pure but for the injected fetcher.
    """
    all_klines = await asyncio.gather(*(fetch_klines(c.ticker) for c in candidates))
    hits: list[SpikeHit] = []
    for c, candles in zip(candidates, all_klines, strict=True):
        spike = detect_spike(candles)
        if spike is None:
            continue
        hits.append(
            SpikeHit(ticker=c.ticker, name=c.name, price=c.price, tracked=c.tracked, spike=spike)
        )
    return sorted(hits, key=lambda h: (-h.spike.volume_mult, h.ticker))
