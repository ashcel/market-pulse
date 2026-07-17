"""Market snapshot — the single dashboard read model (port of market.ts, pure parts).

Defines the tracked universe and computes one `MarketSnapshot` from supplied
1H klines: per-asset quant scores, regime, rotation, heatmap sectors,
volatility, and sentiment. The TS module's fetchers, caches, and server
function are backend concerns; the engine builds snapshots from candles it is
given (`build_snapshot`) or from the deterministic mock series
(`build_demo_snapshot`).
"""

import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from smc.analysis import compute_pivots
from smc.crypto_config import CRYPTO_RISK_SETTINGS
from smc.mock_candles import generate_mock_candles
from smc.quant import SignalEvaluation, classify_regime, evaluate_signal
from smc.relative import compute_relative_read
from smc.types import Candle


@dataclass(slots=True)
class UniverseEntry:
    ticker: str
    name: str
    sector: str


# Curated Binance USDT spot universe, bucketed the way capital actually rotates.
UNIVERSE: list[UniverseEntry] = [
    UniverseEntry("BTC", "Bitcoin", "Majors"),
    UniverseEntry("ETH", "Ethereum", "Majors"),
    UniverseEntry("SOL", "Solana", "Layer 1"),
    UniverseEntry("BNB", "BNB Chain", "Layer 1"),
    UniverseEntry("XRP", "XRP", "Layer 1"),
    UniverseEntry("ADA", "Cardano", "Layer 1"),
    UniverseEntry("AVAX", "Avalanche", "Layer 1"),
    UniverseEntry("SUI", "Sui", "Layer 1"),
    UniverseEntry("NEAR", "NEAR Protocol", "Layer 1"),
    UniverseEntry("LINK", "Chainlink", "DeFi"),
    UniverseEntry("UNI", "Uniswap", "DeFi"),
    UniverseEntry("AAVE", "Aave", "DeFi"),
    UniverseEntry("FET", "Artificial Superintelligence", "AI"),
    UniverseEntry("RENDER", "Render", "AI"),
    UniverseEntry("TAO", "Bittensor", "AI"),
    UniverseEntry("DOGE", "Dogecoin", "Meme"),
    UniverseEntry("PEPE", "Pepe", "Meme"),
    UniverseEntry("WIF", "dogwifhat", "Meme"),
]

SECTOR_ORDER = ["Majors", "Layer 1", "DeFi", "AI", "Meme"]

# Worker-only sampling extension (P2.1, EDR 0011). The forward-test worker
# evaluates `WORKER_UNIVERSE` = dashboard `UNIVERSE` + these, roughly tripling
# evidence throughput; the dashboard/rotation product surface stays on the
# curated 18. Sampling-frame change only — per-symbol decision semantics are
# untouched; `engine_run.universe_json` records the evaluated set per pass and
# every record carries its symbol, keeping cohorts separable. Every ticker
# verified TRADING on BOTH Binance spot and USDS-M futures on 2026-07-12.
WORKER_UNIVERSE_EXTENSION: list[UniverseEntry] = [
    UniverseEntry("LTC", "Litecoin", "Layer 1"),
    UniverseEntry("BCH", "Bitcoin Cash", "Layer 1"),
    UniverseEntry("ETC", "Ethereum Classic", "Layer 1"),
    UniverseEntry("DOT", "Polkadot", "Layer 1"),
    UniverseEntry("ATOM", "Cosmos", "Layer 1"),
    UniverseEntry("FIL", "Filecoin", "Layer 1"),
    UniverseEntry("APT", "Aptos", "Layer 1"),
    UniverseEntry("ARB", "Arbitrum", "Layer 1"),
    UniverseEntry("OP", "Optimism", "Layer 1"),
    UniverseEntry("TRX", "TRON", "Layer 1"),
    UniverseEntry("XLM", "Stellar", "Layer 1"),
    UniverseEntry("HBAR", "Hedera", "Layer 1"),
    UniverseEntry("ICP", "Internet Computer", "Layer 1"),
    UniverseEntry("TIA", "Celestia", "Layer 1"),
    UniverseEntry("SEI", "Sei", "Layer 1"),
    UniverseEntry("ALGO", "Algorand", "Layer 1"),
    UniverseEntry("STX", "Stacks", "Layer 1"),
    UniverseEntry("INJ", "Injective", "DeFi"),
    UniverseEntry("LDO", "Lido DAO", "DeFi"),
    UniverseEntry("CRV", "Curve", "DeFi"),
    UniverseEntry("RUNE", "THORChain", "DeFi"),
    UniverseEntry("ENA", "Ethena", "DeFi"),
    UniverseEntry("ONDO", "Ondo", "DeFi"),
    UniverseEntry("JUP", "Jupiter", "DeFi"),
    UniverseEntry("ETHFI", "Ether.fi", "DeFi"),
    UniverseEntry("GRT", "The Graph", "AI"),
    UniverseEntry("WLD", "Worldcoin", "AI"),
    UniverseEntry("AR", "Arweave", "AI"),
    UniverseEntry("SHIB", "Shiba Inu", "Meme"),
    UniverseEntry("BONK", "Bonk", "Meme"),
    UniverseEntry("IMX", "Immutable", "Gaming"),
    UniverseEntry("ZEC", "Zcash", "Privacy"),
]

# The set the forward-test worker actually evaluates. Superset of UNIVERSE.
WORKER_UNIVERSE: list[UniverseEntry] = [*UNIVERSE, *WORKER_UNIVERSE_EXTENSION]


def tradingview_symbol(ticker: str) -> str:
    return f"BINANCE:{ticker.upper()}USDT"


SignalStatusUi = Literal["bullish", "bearish", "neutral", "warning"]
SnapshotSource = Literal["live", "demo"]


@dataclass(slots=True)
class SparkPoint:
    t: int
    v: float


@dataclass(slots=True)
class Asset:
    id: str
    ticker: str
    name: str
    category: str
    sector: str
    price: float
    change24h: float
    change7d: float
    quote_volume24h: int
    spark: list[SparkPoint]
    momentum: float
    strength: float
    volume: float
    technical: float
    confidence: float
    score: float
    decision: str
    setup_type: str
    # Relative strength vs BTC: this asset's % change minus BTC's, 24h / 7d.
    rs_btc24h: float | None = None
    rs_btc7d: float | None = None
    # Pearson correlation of hourly returns vs BTC over <=7d; None when history is too thin.
    corr_btc7d: float | None = None


@dataclass(slots=True)
class Signal:
    label: str
    value: str
    status: SignalStatusUi
    detail: str | None = None


@dataclass(slots=True)
class BacktestBrief:
    win_rate: float
    low_sample: bool


@dataclass(slots=True)
class AssetSignals:
    signals: list[Signal]
    confidence: int
    # Backtest statistics for this ticker's detected setup, when available.
    backtest: BacktestBrief | None = None


@dataclass(slots=True)
class TimelinePoint:
    t: int
    value: float
    regime: str


@dataclass(slots=True)
class RegimePillar:
    label: str
    score: float
    status: Literal["bullish", "bearish", "neutral"]
    description: str
    display_value: str | None = None


@dataclass(slots=True)
class MarketRegimeData:
    regime: Literal["Risk On", "Risk Off", "Neutral"]
    confidence: float
    trend_strength: Literal["High", "Medium", "Low"]
    timeline: list[TimelinePoint]
    pillars: list[RegimePillar]


@dataclass(slots=True)
class RotationLeg:
    from_sector: str
    to_sector: str
    strength: float


@dataclass(slots=True)
class RotationData:
    flow: list[str]
    legs: list[RotationLeg]
    strength: Literal["High", "Medium", "Low"]
    confidence: float
    rank_agreement: float
    winning: str
    losing: str
    winning_change: float | None = None
    losing_change: float | None = None


@dataclass(slots=True)
class SectorTile:
    group: str
    ticker: str
    name: str
    change: float


@dataclass(slots=True)
class SentimentData:
    label: Literal["Bullish", "Bearish", "Neutral"]
    score: float
    fear_greed: float
    # "api" when the real Fear & Greed index was supplied; "proxy" when it fell
    # back to the internal breadth/momentum estimate.
    source: Literal["api", "proxy"]


@dataclass(slots=True)
class TechnicalData:
    label: Literal["Strong", "Weak", "Mixed"]
    score: float


@dataclass(slots=True)
class VolatilityData:
    label: Literal["Low", "Medium", "High"]
    vix: float
    change: float
    spark: list[SparkPoint]


@dataclass(slots=True)
class MarketSnapshot:
    source: SnapshotSource
    updated_at: str
    assets: list[Asset]
    regime: MarketRegimeData
    rotation: RotationData
    sectors: list[SectorTile]
    sentiment: SentimentData
    technical: TechnicalData
    volatility: VolatilityData
    asset_signals: dict[str, AssetSignals]


HOURS_24 = 24
HOURS_7D = 168


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _js_round(value: float) -> float:
    """JS Math.round — half toward +infinity."""
    return math.floor(value + 0.5)


def _round(value: float, digits: int = 0) -> float:
    scale = 10.0**digits
    return _js_round(value * scale) / scale


def _fmt(value: float) -> str:
    """Embed a number in display copy the way JS template strings do (no trailing .0)."""
    return str(int(value)) if float(value).is_integer() else str(value)


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _sma_at(candles: list[Candle], length: int) -> float | None:
    if len(candles) < length:
        return None
    return _mean([c.close for c in candles[-length:]])


def _atr_percent(candles: list[Candle], length: int = 14) -> float | None:
    if len(candles) < length + 1:
        return None
    ranges: list[float] = []
    for i in range(len(candles) - length, len(candles)):
        c = candles[i]
        prev = candles[i - 1]
        ranges.append(max(c.high - c.low, abs(c.high - prev.close), abs(c.low - prev.close)))
    last_close = candles[-1].close
    if not last_close:
        return None
    return (_mean(ranges) / last_close) * 100


def _change_over_bars(candles: list[Candle], bars: int) -> float:
    if not candles:
        return 0.0
    base = candles[max(0, len(candles) - 1 - bars)]
    if base.close == 0:
        return 0.0
    return _round((candles[-1].close - base.close) / base.close * 100, 2)


def _tanh_score(value: float, scale: float) -> float:
    """Squashes an unbounded % move into a 0-100 score centred at 50."""
    return _clamp(_round(50 + 50 * math.tanh(value / scale)), 0, 100)


def _title_case(slug: str) -> str:
    return re.sub(r"\b\w", lambda m: m.group(0).upper(), slug.replace("-", " "))


@dataclass(slots=True)
class ScoredAsset:
    asset: Asset
    evaluation: SignalEvaluation
    above_weekly_mean: bool
    volume_ratio: float


def score_asset(entry: UniverseEntry, candles: list[Candle]) -> ScoredAsset:
    close = candles[-1].close if candles else 0.0
    change24h = _change_over_bars(candles, HOURS_24)
    change7d = _change_over_bars(candles, HOURS_7D)

    momentum = _round(0.6 * _tanh_score(change24h, 6) + 0.4 * _tanh_score(change7d, 15))

    ma24 = _sma_at(candles, 24)
    ma72 = _sma_at(candles, 72)
    ma168 = _sma_at(candles, HOURS_7D)
    range_high = max((c.high for c in candles), default=0.0)
    range_low = min((c.low for c in candles), default=0.0)
    range_pos = (close - range_low) / (range_high - range_low) if range_high > range_low else 0.5
    strength = _clamp(
        _round(
            40
            + (0 if ma24 is None else (10 if close > ma24 else -10))
            + (0 if ma72 is None else (10 if close > ma72 else -10))
            + (0 if ma168 is None else (10 if close > ma168 else -10))
            + range_pos * 20
        ),
        0,
        100,
    )

    vol24 = sum(c.volume for c in candles[-HOURS_24:])
    prior_windows = candles[-HOURS_7D:-HOURS_24]
    prior_per_day = (
        sum(c.volume for c in prior_windows) / len(prior_windows) * HOURS_24
        if len(prior_windows) >= HOURS_24
        else vol24
    )
    volume_ratio = vol24 / prior_per_day if prior_per_day > 0 else 1.0
    volume_score = _tanh_score((volume_ratio - 1) * 100, 80)

    pivots = compute_pivots(candles)
    evaluation = evaluate_signal(entry.ticker, candles, pivots, CRYPTO_RISK_SETTINGS)
    technical = float(evaluation.confidence)

    quote_volume24h = sum(c.volume * c.close for c in candles[-HOURS_24:])
    spark = [SparkPoint(t=i, v=c.close) for i, c in enumerate(candles[-48:])]

    asset = Asset(
        id=entry.ticker.lower(),
        ticker=entry.ticker,
        name=entry.name,
        category="crypto",
        sector=entry.sector,
        price=close,
        change24h=change24h,
        change7d=change7d,
        quote_volume24h=int(_js_round(quote_volume24h)),
        spark=spark,
        momentum=momentum,
        strength=strength,
        volume=volume_score,
        technical=technical,
        confidence=_round(0.5 * technical + 0.25 * momentum + 0.25 * strength),
        score=_round(0.3 * momentum + 0.25 * strength + 0.25 * technical + 0.2 * volume_score),
        decision=evaluation.decision,
        setup_type=evaluation.setup_type,
    )

    return ScoredAsset(
        asset=asset,
        evaluation=evaluation,
        above_weekly_mean=(close > ma168) if ma168 is not None else change7d > 0,
        volume_ratio=volume_ratio,
    )


_COMPONENT_STATUS: dict[str, SignalStatusUi] = {
    "pass": "bullish",
    "fail": "bearish",
    "warning": "warning",
    "neutral": "neutral",
}

_COMPONENT_VALUE = {
    "pass": "Confirmed",
    "warning": "Caution",
    "fail": "Failed",
    "neutral": "Neutral",
}


def signals_for(scored: ScoredAsset) -> AssetSignals:
    e = scored.evaluation
    decision_status: SignalStatusUi = (
        "bullish"
        if e.decision == "buy-candidate"
        else "bearish"
        if e.decision in ("short-candidate", "invalidated")
        else "warning"
    )
    regime_status: SignalStatusUi = (
        "bullish"
        if e.regime == "trending-up"
        else "bearish"
        if e.regime == "trending-down"
        else "warning"
        if e.regime in ("high-volatility", "choppy")
        else "neutral"
    )

    atr_pct = "–" if e.analytics.atr_percent is None else _fmt(e.analytics.atr_percent)  # noqa: RUF001 — en dash matches the TS copy
    high_label = e.structure.last_high.label if e.structure.last_high else None
    low_label = e.structure.last_low.label if e.structure.last_low else None
    break_note = (
        f"; latest break: {'BOS' if e.structure.event == 'bos' else 'CHoCH'}"
        if e.structure.event
        else ""
    )

    signals: list[Signal] = [
        Signal(
            label="Decision", value=_title_case(e.decision), status=decision_status, detail=e.reason
        ),
        Signal(
            label="Setup",
            value=_title_case(e.setup_type),
            status="neutral" if e.setup_type == "no-clear-setup" else decision_status,
            detail="Engine-classified structure on 1H bars.",
        ),
        Signal(
            label="Regime",
            value=_title_case(e.regime),
            status=regime_status,
            detail=f"ATR {atr_pct}% of price.",
        ),
        Signal(
            label="Structure",
            value=(
                "Uptrend (HH/HL)"
                if e.structure.trend == "uptrend"
                else "Downtrend (LH/LL)"
                if e.structure.trend == "downtrend"
                else "Range"
            ),
            status=(
                "bullish"
                if e.structure.trend == "uptrend"
                else "bearish"
                if e.structure.trend == "downtrend"
                else "neutral"
            ),
            detail=(
                f"Swing legs on 1H bars read {high_label or '–'} high / "  # noqa: RUF001 — en dash matches the TS copy
                f"{low_label or '–'} low{break_note}."  # noqa: RUF001 — en dash matches the TS copy
            ),
        ),
        *(
            Signal(
                label=c.name,
                value=_COMPONENT_VALUE.get(c.status, "Neutral"),
                status=_COMPONENT_STATUS.get(c.status, "neutral"),
                detail=c.explanation,
            )
            for c in e.components
        ),
    ]
    return AssetSignals(
        signals=signals,
        confidence=e.confidence,
        backtest=(
            BacktestBrief(win_rate=e.backtest.win_rate, low_sample=e.backtest.low_sample)
            if e.backtest.total_trades > 0
            else None
        ),
    )


@dataclass(slots=True)
class _RegimeBuild:
    regime: MarketRegimeData
    breadth: float
    avg_momentum: float
    vol_score: float
    atr_pct_daily: float


def _format_billions(value: float) -> str:
    if value >= 1e9:
        return f"{_fmt(_round(value / 1e9, 1))}B"
    if value >= 1e6:
        return f"{_fmt(_round(value / 1e6, 1))}M"
    return f"{int(_js_round(value)):,}"


def _pillar_status(score: float) -> Literal["bullish", "bearish", "neutral"]:
    return "bullish" if score >= 60 else "bearish" if score <= 40 else "neutral"


def build_regime(btc_daily: list[Candle], scored: list[ScoredAsset]) -> _RegimeBuild:
    btc_regime = classify_regime(btc_daily)
    trend_score_map = {
        "trending-up": 85.0,
        "breakout-compression": 62.0,
        "low-volatility": 55.0,
        "range-bound": 52.0,
        "mean-reversion": 48.0,
        "choppy": 42.0,
        "high-volatility": 35.0,
        "trending-down": 18.0,
    }
    trend_score = trend_score_map.get(btc_regime, 50.0)

    n_above = sum(1 for s in scored if s.above_weekly_mean)
    breadth = _round(n_above / max(1, len(scored)) * 100)
    avg_momentum = _round(_mean([s.asset.momentum for s in scored]))
    atr_pct_daily = _atr_percent(btc_daily) or 3.0
    vol_score = _clamp(_round(115 - atr_pct_daily * 18), 5, 95)
    participating = sum(1 for s in scored if s.volume_ratio > 1)
    participation = _round(participating / max(1, len(scored)) * 100)
    total_quote = sum(s.asset.quote_volume24h for s in scored)
    avg24 = _round(_mean([s.asset.change24h for s in scored]), 2)
    avg7 = _round(_mean([s.asset.change7d for s in scored]), 2)

    risk_score = _round(0.35 * trend_score + 0.25 * breadth + 0.2 * avg_momentum + 0.2 * vol_score)
    label: Literal["Risk On", "Risk Off", "Neutral"] = (
        "Risk On" if risk_score >= 60 else "Risk Off" if risk_score <= 42 else "Neutral"
    )

    timeline: list[TimelinePoint] = []
    sessions = min(60, max(0, len(btc_daily) - 21))
    for i in range(len(btc_daily) - sessions, len(btc_daily)):
        window = btc_daily[: i + 1]
        ma20 = _sma_at(window, 20)
        close = window[-1].close
        if not ma20 or not close:
            continue
        dist = (close - ma20) / ma20 * 100
        value = _clamp(_round(50 + dist * 3, 1), 4, 96)
        timeline.append(
            TimelinePoint(
                t=len(timeline),
                value=value,
                regime="Risk On" if value > 60 else "Neutral" if value >= 40 else "Risk Off",
            )
        )

    wide = " — expect wide swings" if atr_pct_daily > 4.2 else ""
    regime = MarketRegimeData(
        regime=label,
        confidence=_clamp(_round(48 + abs(risk_score - 50) * 1.6), 45, 97),
        trend_strength=(
            "High"
            if abs(risk_score - 50) > 20
            else "Medium"
            if abs(risk_score - 50) > 10
            else "Low"
        ),
        timeline=timeline,
        pillars=[
            RegimePillar(
                label="Trend",
                score=trend_score,
                status=_pillar_status(trend_score),
                description=(
                    f"BTC daily structure reads {_title_case(btc_regime).lower()}; "
                    "trend is the heaviest input to the regime call."
                ),
                display_value=_title_case(btc_regime),
            ),
            RegimePillar(
                label="Breadth",
                score=breadth,
                status=_pillar_status(breadth),
                description=(
                    f"{n_above} of {len(scored)} tracked assets trade above their "
                    "7-day average price."
                ),
            ),
            RegimePillar(
                label="Volatility",
                score=vol_score,
                status=_pillar_status(vol_score),
                description=f"BTC 14-day ATR is {_fmt(_round(atr_pct_daily, 1))}% of price{wide}.",
                display_value=f"{_fmt(_round(atr_pct_daily, 1))}%",
            ),
            RegimePillar(
                label="Momentum",
                score=avg_momentum,
                status=_pillar_status(avg_momentum),
                description=(
                    f"Universe averages {'+' if avg24 >= 0 else ''}{_fmt(avg24)}% over 24h "
                    f"and {'+' if avg7 >= 0 else ''}{_fmt(avg7)}% over 7 days."
                ),
            ),
            RegimePillar(
                label="Participation",
                score=participation,
                status=_pillar_status(participation),
                description=(
                    f"{_fmt(participation)}% of assets printing above-average volume; "
                    f"~${_format_billions(total_quote)} traded in 24h."
                ),
            ),
        ],
    )

    return _RegimeBuild(
        regime=regime,
        breadth=breadth,
        avg_momentum=avg_momentum,
        vol_score=vol_score,
        atr_pct_daily=atr_pct_daily,
    )


def _rank_index(values: list[tuple[str, float]]) -> dict[str, int]:
    ordered = sorted(values, key=lambda item: -item[1])
    return {name: i for i, (name, _) in enumerate(ordered)}


@dataclass(slots=True)
class _SectorStat:
    name: str
    avg24: float
    avg7: float


def build_rotation(scored: list[ScoredAsset]) -> tuple[RotationData, list[SectorTile]]:
    by_sector: dict[str, list[ScoredAsset]] = {}
    for s in scored:
        by_sector.setdefault(s.asset.sector or "Other", []).append(s)

    stats = [
        _SectorStat(
            name=name,
            avg24=_round(_mean([i.asset.change24h for i in by_sector[name]]), 2),
            avg7=_round(_mean([i.asset.change7d for i in by_sector[name]]), 2),
        )
        for name in SECTOR_ORDER
        if name in by_sector
    ]

    # Money exits the weakest bucket and chases the strongest: order losers → winners.
    ordered = sorted(stats, key=lambda s: s.avg24)
    low = ordered[0].avg24 if ordered else 0.0
    high = ordered[-1].avg24 if ordered else 0.0
    spread = max(0.0001, high - low)

    flow = [s.name for s in ordered]
    legs = [
        RotationLeg(
            from_sector=s.name,
            to_sector=ordered[i + 1].name,
            strength=_clamp(_round((s.avg24 - low) / spread * 100), 0, 100),
        )
        for i, s in enumerate(ordered[:-1])
    ]

    rank24 = _rank_index([(s.name, s.avg24) for s in stats])
    rank7 = _rank_index([(s.name, s.avg7) for s in stats])
    n = len(stats)
    d_squared = sum((rank24.get(s.name, 0) - rank7.get(s.name, 0)) ** 2 for s in stats)
    rho = 1 - (6 * d_squared) / (n * (n * n - 1)) if n > 1 else 0.0

    winning = ordered[-1] if ordered else None
    losing = ordered[0] if ordered else None
    rotation = RotationData(
        flow=flow,
        legs=legs,
        strength="High" if spread >= 3 else "Medium" if spread >= 1.2 else "Low",
        confidence=_clamp(_round(55 + rho * 40), 30, 95),
        rank_agreement=_round(rho, 2),
        winning=winning.name if winning else "—",
        losing=losing.name if losing else "—",
        winning_change=winning.avg24 if winning else None,
        losing_change=losing.avg24 if losing else None,
    )

    sectors = [
        SectorTile(
            group=(s.asset.sector or "Other").upper(),
            ticker=s.asset.ticker,
            name=s.asset.name,
            change=s.asset.change24h,
        )
        for s in scored
    ]

    return rotation, sectors


def build_volatility(btc_daily: list[Candle]) -> VolatilityData:
    spark: list[SparkPoint] = []
    sessions = min(40, max(0, len(btc_daily) - 15))
    for i in range(len(btc_daily) - sessions, len(btc_daily)):
        value = _atr_percent(btc_daily[: i + 1])
        if value is not None:
            spark.append(SparkPoint(t=len(spark), v=_round(value, 2)))
    current = spark[-1].v if spark else 3.0
    week_ago = spark[-8].v if len(spark) >= 8 else current
    return VolatilityData(
        label="Low" if current < 2.2 else "Medium" if current < 4.2 else "High",
        vix=current,
        change=_round((current - week_ago) / week_ago * 100, 2) if week_ago else 0.0,
        spark=spark,
    )


def build_snapshot(
    hourly: dict[str, list[Candle]],
    btc_daily: list[Candle],
    source: SnapshotSource,
    fear_greed: float | None,
) -> MarketSnapshot:
    """One MarketSnapshot from supplied per-ticker 1H series + BTC daily.

    A UNIVERSE ticker missing from `hourly` (or too short) falls back to its
    own mock candles — partial per-asset failure never fails the snapshot.
    """

    def series_for(ticker: str) -> list[Candle]:
        candles = hourly.get(ticker)
        if candles is not None and len(candles) >= 48:
            return candles
        return generate_mock_candles(ticker, "1H")

    btc_hourly = series_for("BTC")
    scored: list[ScoredAsset] = []
    for entry in UNIVERSE:
        candles = series_for(entry.ticker)
        s = score_asset(entry, candles)
        # Relative strength + correlation vs BTC — display-only fields computed
        # from the exact series the asset was scored on (relative.py).
        read = compute_relative_read(candles, btc_hourly)
        s.asset.rs_btc24h = read.rs_btc24h
        s.asset.rs_btc7d = read.rs_btc7d
        s.asset.corr_btc7d = read.corr_btc7d
        scored.append(s)

    regime_build = build_regime(btc_daily, scored)
    rotation, sectors = build_rotation(scored)
    volatility = build_volatility(btc_daily)

    fg = (
        fear_greed
        if fear_greed is not None
        else _round(0.5 * regime_build.breadth + 0.5 * regime_build.avg_momentum)
    )
    sentiment = SentimentData(
        label="Bullish" if fg >= 60 else "Bearish" if fg <= 40 else "Neutral",
        score=fg,
        fear_greed=fg,
        source="api" if fear_greed is not None else "proxy",
    )

    avg_technical = _round(_mean([s.asset.technical for s in scored]))
    technical = TechnicalData(
        label="Strong" if avg_technical >= 65 else "Weak" if avg_technical <= 45 else "Mixed",
        score=avg_technical,
    )

    asset_signals = {s.asset.ticker: signals_for(s) for s in scored}
    assets = sorted((s.asset for s in scored), key=lambda a: -a.score)

    return MarketSnapshot(
        source=source,
        updated_at=datetime.now(UTC).isoformat(),
        assets=assets,
        regime=regime_build.regime,
        rotation=rotation,
        sectors=sectors,
        sentiment=sentiment,
        technical=technical,
        volatility=volatility,
        asset_signals=asset_signals,
    )


def build_demo_snapshot() -> MarketSnapshot:
    hourly = {entry.ticker: generate_mock_candles(entry.ticker, "1H") for entry in UNIVERSE}
    return build_snapshot(hourly, generate_mock_candles("BTC", "1D", 120), "demo", None)
