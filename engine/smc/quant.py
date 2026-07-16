"""Signal scoring — evaluate_signal, the core (port of quant.ts)."""

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from smc.analysis import compute_pivots
from smc.equilibrium import (
    DealingRange,
    PricePosition,
    classify_price,
    compute_dealing_range,
)
from smc.liquidity import (
    LiquidityPool,
    LiquiditySweep,
    compute_liquidity_pools,
    detect_liquidity_sweeps,
)
from smc.objectives import ObjectiveCandidate, resolve_objectives
from smc.poi import AnticipatoryPlan, build_anticipatory_plan
from smc.strength import SwingStrengthEntry, derive_swing_strength
from smc.structure import (
    MarketStructure,
    compute_market_structure,
    structure_lean,
    to_alternating_swings,
)
from smc.types import Candle, PivotPoint
from smc.zones import BaseZone

SignalStatus = Literal["pass", "fail", "warning", "neutral"]
TradeDecision = Literal["buy-candidate", "short-candidate", "wait", "no-trade", "invalidated"]
SetupType = Literal[
    "breakout",
    "failed-breakout",
    "pullback-continuation",
    "vwap-reclaim",
    "lower-high-rejection",
    "higher-low-continuation",
    "capitulation-reversal",
    "range-compression",
    "trendline-break",
    "retest-entry",
    "exhaustion-move",
    "no-clear-setup",
]
MarketRegime = Literal[
    "trending-up",
    "trending-down",
    "range-bound",
    "high-volatility",
    "low-volatility",
    "breakout-compression",
    "mean-reversion",
    "choppy",
]
StopMethod = Literal["swing", "atr", "fixed-percent"]
TradeDirection = Literal["long", "short", "none"]
RiskGrade = Literal["low", "medium", "high"]

# Below this many replayed trades, win rate/expectancy are noise, not signal.
MIN_RELIABLE_BACKTEST_TRADES = 10

# ATR% bands for the risk grade: below `medium` is calm, above `high` is wild.
_RISK_GRADE_ATR_BANDS = {"medium": 2.2, "high": 4.5}


@dataclass(slots=True)
class SignalComponent:
    name: str
    status: SignalStatus
    score: float
    explanation: str


@dataclass(slots=True)
class RiskSettings:
    account_size: float
    max_risk_per_trade_percent: float
    max_daily_loss_percent: float
    minimum_reward_risk: float
    atr_stop_multiplier: float
    fixed_stop_percent: float
    stop_method: StopMethod


DEFAULT_RISK_SETTINGS = RiskSettings(
    account_size=100_000,
    max_risk_per_trade_percent=0.75,
    max_daily_loss_percent=2,
    minimum_reward_risk=1.8,
    atr_stop_multiplier=1.5,
    fixed_stop_percent=2,
    stop_method="swing",
)


@dataclass(slots=True)
class RiskRewardPlan:
    direction: TradeDirection
    entry: float
    # Ideal acceptable entry zone (a pullback/rally toward structure), bounded by the stop.
    entry_low: float
    entry_high: float
    stop: float
    target1: float
    target2: float
    risk_per_unit: float
    reward_per_unit1: float
    reward_per_unit2: float
    reward_risk1: float
    reward_risk2: float
    max_dollar_risk: float
    position_size: float
    max_dollar_loss: float
    estimated_gain1: float
    estimated_gain2: float
    invalidation: float


@dataclass(slots=True)
class AnalyticsSummary:
    last_close: float
    change_percent: float
    sma20: float | None
    sma50: float | None
    atr14: float | None
    atr_percent: float | None
    avg_volume20: float | None
    volume_ratio: float | None
    support: float | None
    resistance: float | None
    distance_to_support_percent: float | None
    distance_to_resistance_percent: float | None


@dataclass(slots=True)
class BacktestSummary:
    strategy_name: str
    strategy_version: str
    total_trades: int
    win_rate: float
    average_win: float
    average_loss: float
    profit_factor: float
    expectancy: float
    max_drawdown: float
    average_r: float
    best_trade_r: float
    worst_trade_r: float
    consecutive_wins: int
    consecutive_losses: int
    # True when total_trades is too small to trust the stats above.
    low_sample: bool


@dataclass(slots=True)
class SignalEvaluation:
    symbol: str
    setup_type: SetupType
    decision: TradeDecision
    # The raw setup direction — may be a trade the engine itself refuses.
    direction: TradeDirection
    # The timeframe's reconciled directional lean (see directional_lean).
    lean: TradeDirection
    regime: MarketRegime
    # Swing-labeled market structure behind the setup call.
    structure: MarketStructure
    # Liquidity pools from the structure's EQH/EQL clusters, strongest first.
    liquidity: list[LiquidityPool]
    # Stop hunts on those pools (time order).
    liquidity_sweeps: list[LiquiditySweep]
    # Strong/weak typing over structure.swings (instrumentation; EDR 0004).
    swing_strength: list[SwingStrengthEntry]
    # Active dealing range from the last strong swing; None until one exists (EDR 0005).
    dealing_range: DealingRange | None
    # Where the evaluated price sits in that range; None exactly when dealing_range is.
    price_position: PricePosition | None
    # Ranked draw-on-liquidity candidates, preferred first; empty = no clean target (EDR 0008).
    objectives: list[ObjectiveCandidate]
    # Limit-at-POI plan targeting objectives[0] (EDR 0009); inert instrumentation.
    anticipatory_plan: AnticipatoryPlan | None
    confidence: int
    components: list[SignalComponent]
    no_trade_reasons: list[str]
    reason: str
    risk: RiskRewardPlan
    analytics: AnalyticsSummary
    backtest: BacktestSummary
    strategy_version: str = field(default="QuantDeskSignal_v1")
    evaluated_at: str = field(default="")


def _js_round(value: float) -> float:
    """JS Math.round — half toward +infinity."""
    return math.floor(value + 0.5)


def _round(value: float, digits: int = 2) -> float:
    scale = 10.0**digits
    return _js_round(value * scale) / scale


def round_price(value: float) -> float:
    """Magnitude-aware price rounding — fixed 2dp collapses sub-dollar assets."""
    abs_ = abs(value)
    if abs_ == 0 or not math.isfinite(value):
        return value
    if abs_ >= 100:
        return _round(value, 2)
    if abs_ >= 1:
        return _round(value, 4)
    if abs_ >= 0.01:
        return _round(value, 6)
    # Below a cent: keep 5 significant digits.
    return _round(value, min(12, -math.floor(math.log10(abs_)) + 4))


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def sma(candles: list[Candle], length: int) -> float | None:
    if len(candles) < length:
        return None
    return _mean([c.close for c in candles[-length:]])


def atr(candles: list[Candle], length: int) -> float | None:
    if len(candles) < length + 1:
        return None
    ranges: list[float] = []
    for i in range(len(candles) - length, len(candles)):
        c = candles[i]
        prev = candles[i - 1]
        ranges.append(max(c.high - c.low, abs(c.high - prev.close), abs(c.low - prev.close)))
    return _mean(ranges)


# The regime thresholds are absolute percentages calibrated on 4H bars.
# Volatility grows roughly with the square root of bar duration, so shorter
# bars must scale them down.
_BASELINE_BAR_SECONDS = 4 * 60 * 60


def _volatility_scale(candles: list[Candle]) -> float:
    if len(candles) < 2:
        return 1
    step = candles[-1].time - candles[-2].time
    if step <= 0:
        return 1
    return min(1, math.sqrt(step / _BASELINE_BAR_SECONDS))


def _slope(values: list[float]) -> float:
    if len(values) < 2:
        return 0
    return (values[-1] - values[0]) / len(values)


def _nearest_support(candles: list[Candle], pivots: list[PivotPoint]) -> float | None:
    if not candles:
        return None
    close = candles[-1].close
    if not math.isfinite(close):
        return None
    supports = sorted(
        (p.price for p in pivots if p.kind == "low" and p.price < close), reverse=True
    )
    if supports:
        return supports[0]
    # Exclude current candle: use previous 20, not last 20.
    prev_candles = candles[-21:-1]
    return min(c.low for c in prev_candles) if prev_candles else close


def _nearest_resistance(candles: list[Candle], pivots: list[PivotPoint]) -> float | None:
    if not candles:
        return None
    close = candles[-1].close
    if not math.isfinite(close):
        return None
    resistances = sorted(p.price for p in pivots if p.kind == "high" and p.price > close)
    if resistances:
        return resistances[0]
    prev_candles = candles[-21:-1]
    return max(c.high for c in prev_candles) if prev_candles else close


def grade_risk(atr_percent: float | None, counter_trend: bool = False) -> RiskGrade | None:
    """The single risk-level read for UI chips: ATR% sets the base grade, and a
    counter-trend trade bumps it one level. None when there is no ATR read."""
    if atr_percent is None or not math.isfinite(atr_percent):
        return None
    base: RiskGrade = (
        "low"
        if atr_percent < _RISK_GRADE_ATR_BANDS["medium"]
        else "medium"
        if atr_percent < _RISK_GRADE_ATR_BANDS["high"]
        else "high"
    )
    if not counter_trend:
        return base
    return "medium" if base == "low" else "high"


def _humanize_setup(setup: SetupType) -> str:
    return " ".join(word[0].upper() + word[1:] for word in setup.split("-"))


def analytics_for(candles: list[Candle], pivots: list[PivotPoint]) -> AnalyticsSummary:
    current = candles[-1] if candles else None
    prev = candles[-2] if len(candles) > 1 else None
    last_close = current.close if current is not None else 0.0
    atr14 = atr(candles, 14)
    avg_volume20 = _mean([c.volume for c in candles[-20:]])
    support = _nearest_support(candles, pivots) if candles else None
    resistance = _nearest_resistance(candles, pivots) if candles else None
    sma20 = sma(candles, 20)
    sma50 = sma(candles, 50)
    return AnalyticsSummary(
        last_close=round_price(last_close),
        change_percent=(
            _round(((last_close - prev.close) / prev.close) * 100, 2)
            if prev is not None and prev.close != 0
            else 0
        ),
        sma20=None if sma20 is None else round_price(sma20),
        sma50=None if sma50 is None else round_price(sma50),
        atr14=None if atr14 is None else round_price(atr14),
        atr_percent=(_round((atr14 / last_close) * 100, 2) if atr14 and last_close else None),
        avg_volume20=None if avg_volume20 is None else _js_round(avg_volume20),
        volume_ratio=(
            _round(current.volume / avg_volume20, 2)
            if avg_volume20 and current is not None and avg_volume20 > 0
            else None
        ),
        support=None if support is None else round_price(support),
        resistance=None if resistance is None else round_price(resistance),
        distance_to_support_percent=(
            _round(((last_close - support) / last_close) * 100, 2)
            if support and last_close
            else None
        ),
        distance_to_resistance_percent=(
            _round(((resistance - last_close) / last_close) * 100, 2)
            if resistance and last_close
            else None
        ),
    )


def classify_regime(candles: list[Candle]) -> MarketRegime:
    if len(candles) < 30:
        return "range-bound"
    current = candles[-1]
    closes = [c.close for c in candles[-30:]]
    ma20 = sma(candles, 20)
    ma50 = sma(candles, 50)
    atr14 = atr(candles, 14)
    atr_base = atr(candles[:-10], 14)
    range_high = max(c.high for c in candles[-20:])
    range_low = min(c.low for c in candles[-20:])
    scale = _volatility_scale(candles)
    compression = atr14 / current.close < 0.012 * scale if atr14 and current.close else False
    range_width = (range_high - range_low) / current.close if current.close else 0
    ma_slope = _slope(closes[-10:])

    if atr14 and atr_base and atr14 > atr_base * 1.45:
        return "high-volatility"
    if compression and range_width < 0.055 * scale:
        return "breakout-compression"
    if atr14 and current.close and atr14 / current.close < 0.008 * scale:
        return "low-volatility"
    if ma20 and ma50 and current.close > ma20 and ma20 > ma50 and ma_slope > 0:
        return "trending-up"
    if ma20 and ma50 and current.close < ma20 and ma20 < ma50 and ma_slope < 0:
        return "trending-down"
    if range_width < 0.06 * scale:
        return "range-bound"
    if abs(ma_slope) < current.close * 0.0008 * scale:
        return "choppy"
    return "mean-reversion"


# A sweep classifies the setup only while its candle is among this many most
# recent closed bars — a raid from further back is history, not a trigger.
SWEEP_SETUP_RECENCY_BARS = 3


def _sweep_is_recent(sweep: LiquiditySweep, candles: list[Candle]) -> bool:
    if not candles:
        return False
    cutoff = candles[max(0, len(candles) - SWEEP_SETUP_RECENCY_BARS)].time
    return sweep.time >= cutoff


def current_sweep(sweeps: list[LiquiditySweep], candles: list[Candle]) -> LiquiditySweep | None:
    """The latest sweep that is still live trigger material — the single
    "is the sweep still news?" rule shared by setup classification and UI."""
    latest = sweeps[-1] if sweeps else None  # sweeps arrive time-ordered
    return latest if latest is not None and _sweep_is_recent(latest, candles) else None


def classify_setup(
    candles: list[Candle],
    pivots: list[PivotPoint],
    regime: MarketRegime,
    structure: MarketStructure | None = None,
    sweeps: list[LiquiditySweep] | None = None,
) -> SetupType:
    if structure is None:
        structure = compute_market_structure(pivots)
    if sweeps is None:
        sweeps = detect_liquidity_sweeps(compute_liquidity_pools(structure), candles)

    current = candles[-1] if candles else None
    prev = candles[-2] if len(candles) > 1 else None
    if current is None or prev is None or len(candles) < 30:
        return "no-clear-setup"
    support = _nearest_support(candles, pivots)
    resistance = _nearest_resistance(candles, pivots)
    atr14 = atr(candles, 14) or current.close * 0.02
    ma20 = sma(candles, 20)
    volume_ratio = analytics_for(candles, pivots).volume_ratio
    if volume_ratio is None:
        volume_ratio = 1

    if (
        resistance
        and prev.close <= resistance
        and current.close > resistance
        and volume_ratio >= 1.2
    ):
        return "breakout"
    # A recent liquidity sweep is the principled version of the raw checks
    # below: buy-side raided and rejected traps breakout longs (failed-breakout
    # short); sell-side raided and rejected is the flush that clears sellers
    # (capitulation-reversal long). A fresh acceptance on the current bar (the
    # breakout branch above) still outranks a raid from a bar or two back.
    recent_sweep = current_sweep(sweeps, candles)
    if recent_sweep is not None:
        return "failed-breakout" if recent_sweep.side == "bsl" else "capitulation-reversal"
    if resistance and prev.high > resistance and current.close < resistance:
        return "failed-breakout"
    if regime == "breakout-compression":
        return "range-compression"
    if (
        ma20
        and current.close > ma20
        and current.low <= ma20 * 1.01
        and current.close > current.open
    ):
        return "pullback-continuation"
    # Structure carries the swing comparison: the most recent low being a
    # higher-low, or the most recent high a lower-high, off the maintained state.
    if structure.last_low is not None and structure.last_low.label == "HL":
        return "higher-low-continuation"
    if structure.last_high is not None and structure.last_high.label == "LH":
        return "lower-high-rejection"
    if support and current.low < support - atr14 * 0.35 and current.close > support:
        return "capitulation-reversal"
    if resistance and abs(current.close - resistance) < atr14 * 0.45:
        return "retest-entry"
    if current.high - current.low > atr14 * 2.5:
        return "exhaustion-move"
    return "no-clear-setup"


def build_risk_plan(
    candles: list[Candle],
    pivots: list[PivotPoint],
    direction: TradeDirection,
    settings: RiskSettings = DEFAULT_RISK_SETTINGS,
    live_price: float | None = None,
) -> RiskRewardPlan:
    """Entry/stop/target plan. Setup classification stays gated on the last
    *closed* bar, but the entry anchors on live_price when supplied — a 4H plan
    must not quote a close hours stale next to a 15M plan minutes stale."""
    current = candles[-1] if candles else None
    entry = (
        live_price
        if live_price is not None and math.isfinite(live_price) and live_price > 0
        else (current.close if current is not None else 0.0)
    )
    atr14 = atr(candles, 14) or entry * 0.02
    support_raw = _nearest_support(candles, pivots)
    support = support_raw if support_raw is not None else entry - atr14 * 1.5
    resistance_raw = _nearest_resistance(candles, pivots)
    resistance = resistance_raw if resistance_raw is not None else entry + atr14 * 2
    # A swing stop belongs under the level the market *defended* — the
    # alternation-collapsed leg extreme — not the nearest raw pivot. Raw levels
    # stay in use for targets and the entry zone (evidence: sr-candidates tests).
    swings = to_alternating_swings(pivots)
    defended_support_raw = _nearest_support(candles, swings)
    defended_support = defended_support_raw if defended_support_raw is not None else support
    defended_resistance_raw = _nearest_resistance(candles, swings)
    defended_resistance = (
        defended_resistance_raw if defended_resistance_raw is not None else resistance
    )
    max_dollar_risk = settings.account_size * (settings.max_risk_per_trade_percent / 100)

    stop = entry
    if direction == "long":
        if settings.stop_method == "fixed-percent":
            stop = entry * (1 - settings.fixed_stop_percent / 100)
        elif settings.stop_method == "atr":
            stop = entry - atr14 * settings.atr_stop_multiplier
        else:
            stop = min(defended_support, entry - atr14 * 0.7)
    elif direction == "short":
        if settings.stop_method == "fixed-percent":
            stop = entry * (1 + settings.fixed_stop_percent / 100)
        elif settings.stop_method == "atr":
            stop = entry + atr14 * settings.atr_stop_multiplier
        else:
            stop = max(defended_resistance, entry + atr14 * 0.7)

    # Ideal entry zone: a bounded pullback (long) or rally (short) toward
    # structure, never worse than just past the stop.
    pullback = atr14 * 1.1
    entry_low = entry
    entry_high = entry
    if direction == "long":
        entry_low = min(entry, max(support, entry - pullback, stop + atr14 * 0.1))
    elif direction == "short":
        entry_high = max(entry, min(resistance, entry + pullback, stop - atr14 * 0.1))

    risk_per_unit = 0.0 if direction == "none" else abs(entry - stop)
    if direction == "long":
        target1 = max(resistance, entry + risk_per_unit * 1.8)
        target2 = entry + risk_per_unit * 3
    elif direction == "short":
        target1 = min(support, entry - risk_per_unit * 1.8)
        target2 = entry - risk_per_unit * 3
    else:
        target1 = entry
        target2 = entry
    reward_per_unit1 = abs(target1 - entry)
    reward_per_unit2 = abs(target2 - entry)
    # Crypto positions are fractional — sizing must not floor to whole units.
    position_size = _round(max_dollar_risk / risk_per_unit, 6) if risk_per_unit > 0 else 0

    return RiskRewardPlan(
        direction=direction,
        entry=round_price(entry),
        entry_low=round_price(entry_low),
        entry_high=round_price(entry_high),
        stop=round_price(stop),
        target1=round_price(target1),
        target2=round_price(target2),
        risk_per_unit=round_price(risk_per_unit),
        reward_per_unit1=round_price(reward_per_unit1),
        reward_per_unit2=round_price(reward_per_unit2),
        reward_risk1=_round(reward_per_unit1 / risk_per_unit, 2) if risk_per_unit > 0 else 0,
        reward_risk2=_round(reward_per_unit2 / risk_per_unit, 2) if risk_per_unit > 0 else 0,
        max_dollar_risk=_round(max_dollar_risk),
        position_size=position_size,
        max_dollar_loss=_round(position_size * risk_per_unit),
        estimated_gain1=_round(position_size * reward_per_unit1),
        estimated_gain2=_round(position_size * reward_per_unit2),
        invalidation=round_price(stop),
    )


def directional_lean(
    direction: TradeDirection,
    regime: MarketRegime,
    structure: MarketStructure,
) -> TradeDirection:
    """The reconciled directional lean of one timeframe. The setup direction
    leads, but a direction the engine itself refuses to trade must not leak
    out as the timeframe's lean. When suppressed (or absent), the lean is
    whatever the regime and the structure agree on."""
    regime_lean: TradeDirection = (
        "long" if regime == "trending-up" else "short" if regime == "trending-down" else "none"
    )
    struct_lean = structure_lean(structure)
    if direction != "none":
        fights_regime = regime_lean != "none" and regime_lean != direction
        fights_structure = struct_lean != "none" and struct_lean != direction
        if not fights_regime and not fights_structure:
            return direction
    if regime_lean == struct_lean:
        return regime_lean
    if regime_lean == "none":
        return struct_lean
    if struct_lean == "none":
        return regime_lean
    return "none"


def _decision_from_setup(setup: SetupType) -> TradeDirection:
    if setup in ("failed-breakout", "lower-high-rejection"):
        return "short"
    if setup in (
        "breakout",
        "pullback-continuation",
        "higher-low-continuation",
        "vwap-reclaim",
        "retest-entry",
        "capitulation-reversal",
    ):
        return "long"
    return "none"


def _status_score(status: SignalStatus, pass_: float, warn: float = -5) -> float:
    if status == "pass":
        return pass_
    if status == "warning":
        return warn
    if status == "fail":
        return -abs(warn)
    return 0


def evaluate_signal(
    symbol: str,
    candles: list[Candle],
    pivots: list[PivotPoint],
    settings: RiskSettings = DEFAULT_RISK_SETTINGS,
    backtest_candles: list[Candle] | None = None,
    live_price: float | None = None,
    zones: list[BaseZone] | None = None,
) -> SignalEvaluation:
    """The core score. The caller owns the SD_ZONE_TIMEFRAMES gate for `zones` —
    zone-less calls simply get no anticipatory plan, never a wrongly-gated one."""
    if backtest_candles is None:
        backtest_candles = candles
    if zones is None:
        zones = []

    current = candles[-1] if candles else None
    analytics = analytics_for(candles, pivots)
    structure = compute_market_structure(pivots)
    liquidity = compute_liquidity_pools(structure)
    liquidity_sweeps = detect_liquidity_sweeps(liquidity, candles)
    # Phase 0 instrumentation: derived views only, read by nothing below.
    swing_strength = derive_swing_strength(structure)
    dealing_range = compute_dealing_range(structure)
    position_price = live_price if live_price is not None else (current.close if current else None)
    price_position = (
        classify_price(dealing_range, position_price)
        if dealing_range is not None and position_price is not None
        else None
    )
    regime = classify_regime(candles)
    setup_type = classify_setup(candles, pivots, regime, structure, liquidity_sweeps)
    direction = _decision_from_setup(setup_type)
    risk = build_risk_plan(candles, pivots, direction, settings, live_price)
    components: list[SignalComponent] = []

    def add(name: str, status: SignalStatus, score: float, explanation: str) -> None:
        components.append(
            SignalComponent(name=name, status=status, score=score, explanation=explanation)
        )

    trend_aligned = (
        regime in ("trending-up", "breakout-compression", "range-bound")
        if direction == "long"
        else regime in ("trending-down", "choppy")
        if direction == "short"
        else False
    )
    # Trading straight into a confirmed opposing trend is the setup a
    # discretionary trader refuses outright, not one they take at a discount.
    against_confirmed_trend = (direction == "long" and regime == "trending-down") or (
        direction == "short" and regime == "trending-up"
    )
    add(
        "Trend alignment",
        "neutral"
        if direction == "none"
        else "pass"
        if trend_aligned
        else "fail"
        if against_confirmed_trend
        else "warning",
        0
        if direction == "none"
        else _status_score(
            "pass" if trend_aligned else "fail" if against_confirmed_trend else "warning", 20, -8
        ),
        "No directional setup is strong enough to require trend confirmation."
        if direction == "none"
        else f"The current regime supports a {direction} thesis."
        if trend_aligned
        else (
            f"This {direction} setup fights a confirmed {regime} regime — "
            "that's the wrong side of the tape."
        )
        if against_confirmed_trend
        else f"The current regime does not cleanly support a {direction} thesis.",
    )

    # Swing structure is the engine's second trend opinion. structure_lean
    # folds the trend and the still-live BOS/CHoCH into one directional read —
    # the same definition the per-timeframe lean uses.
    struct_lean = structure_lean(structure)
    in_trend = structure.trend != "range"
    event_name = "CHoCH" if structure.event == "choch" else "BOS"
    structure_status: SignalStatus
    if direction == "none":
        structure_status = "neutral"
        structure_note = "No directional setup to test against swing structure."
    elif struct_lean == direction:
        structure_status = "pass"
        if in_trend:
            structure_note = (
                "Swing structure agrees: higher highs and higher lows support the long."
                if structure.trend == "uptrend"
                else "Swing structure agrees: lower highs and lower lows support the short."
            )
        else:
            structure_note = (
                f"Structure is ranging, but the latest break is a {event_name} in the "
                f"{direction} direction — an early structural turn in the trade's favor."
            )
    elif struct_lean != "none":
        structure_status = "fail"
        if in_trend:
            trend_desc = "HH/HL uptrend" if structure.trend == "uptrend" else "LH/LL downtrend"
            structure_note = (
                f"Swing structure prints a {trend_desc} — this {direction} fights the "
                "structural trend."
            )
        else:
            structure_note = (
                f"Structure is ranging and the latest break is a {event_name} against the "
                f"{direction} — the most recent structural evidence points the other way."
            )
    else:
        structure_status = "warning"
        structure_note = (
            "Swing structure is range-bound — no HH/HL or LH/LL sequence confirms this "
            "direction yet."
        )
    add(
        "Structure alignment",
        structure_status,
        0 if direction == "none" else _status_score(structure_status, 15, -8),
        structure_note,
    )

    volume_ok = (analytics.volume_ratio or 0) >= 1.15
    add(
        "Volume confirmation",
        "pass" if volume_ok else "warning",
        _status_score("pass" if volume_ok else "warning", 15, -6),
        f"Current volume is {analytics.volume_ratio}x the 20-bar average."
        if volume_ok
        else "Volume is not yet meaningfully above the 20-bar average.",
    )

    midpoint = (current.high + current.low) / 2 if current is not None else 0
    bullish_close = current.close > max(current.open, midpoint) if current is not None else False
    bearish_close = current.close < min(current.open, midpoint) if current is not None else False
    close_confirmed = bearish_close if direction == "short" else bullish_close
    add(
        "Candle close confirmation",
        "pass" if close_confirmed else "warning",
        _status_score("pass" if close_confirmed else "warning", 12, -5),
        (
            "The latest candle closed decisively in the "
            f"{'lower' if direction == 'short' else 'upper'} half of its range."
        )
        if close_confirmed
        else "The latest candle has not confirmed with a decisive close.",
    )

    rr_ok = risk.reward_risk1 >= settings.minimum_reward_risk
    add(
        "Reward/risk",
        "neutral" if direction == "none" else "pass" if rr_ok else "fail",
        0 if direction == "none" else _status_score("pass" if rr_ok else "fail", 18, -18),
        "No trade plan is active."
        if direction == "none"
        else (
            f"Target 1 offers {risk.reward_risk1}R, above the "
            f"{settings.minimum_reward_risk}R minimum."
        )
        if rr_ok
        else (
            f"Target 1 offers only {risk.reward_risk1}R, below the "
            f"{settings.minimum_reward_risk}R minimum."
        ),
    )

    structure_floor = 0.35 * _volatility_scale(candles)
    near_resistance = (
        direction == "long"
        and analytics.distance_to_resistance_percent is not None
        and analytics.distance_to_resistance_percent
        < max(structure_floor, (analytics.atr_percent or 1) * 0.55)
    )
    near_support = (
        direction == "short"
        and analytics.distance_to_support_percent is not None
        and analytics.distance_to_support_percent
        < max(structure_floor, (analytics.atr_percent or 1) * 0.55)
    )
    add(
        "Support/resistance location",
        "warning" if near_resistance or near_support else "pass",
        _status_score("warning" if near_resistance or near_support else "pass", 12, -8),
        "Long entry is close to nearby resistance."
        if near_resistance
        else "Short entry is close to nearby support."
        if near_support
        else "Price has enough room to the next nearby structure level.",
    )

    # Liquidity context: entering a long just below an intact buy-side pool is
    # the textbook stop-hunt entry. The mirror positive: a recent sweep on the
    # trade's far side means the opposing fuel was just cleared.
    pool_proximity_pct = max(structure_floor, (analytics.atr_percent or 1) * 0.55)
    pool_ahead: LiquidityPool | None = None
    if direction != "none":
        for pool in liquidity:
            if not pool.intact or analytics.last_close <= 0:
                continue
            distance_pct = abs(pool.price - analytics.last_close) / analytics.last_close * 100
            if direction == "long":
                if (
                    pool.side == "bsl"
                    and pool.price > analytics.last_close
                    and distance_pct < pool_proximity_pct
                ):
                    pool_ahead = pool
                    break
            elif (
                pool.side == "ssl"
                and pool.price < analytics.last_close
                and distance_pct < pool_proximity_pct
            ):
                pool_ahead = pool
                break
    supportive_sweep: LiquiditySweep | None = None
    if direction != "none":
        wanted = "ssl" if direction == "long" else "bsl"
        supportive_sweep = next(
            (s for s in liquidity_sweeps if s.side == wanted and _sweep_is_recent(s, candles)),
            None,
        )
    add(
        "Liquidity context",
        "neutral" if direction == "none" else "warning" if pool_ahead else "pass",
        0 if direction == "none" else _status_score("warning" if pool_ahead else "pass", 10, -6),
        "No directional setup to test against resting liquidity."
        if direction == "none"
        else (
            (
                f"Long entry sits just below an intact buy-side liquidity pool at "
                f"{round_price(pool_ahead.price)} — the level stop raids reject from."
            )
            if direction == "long"
            else (
                f"Short entry sits just above an intact sell-side liquidity pool at "
                f"{round_price(pool_ahead.price)} — the level stop raids reject from."
            )
        )
        if pool_ahead
        else (
            (
                "The "
                + (
                    "sell-side stops below"
                    if supportive_sweep.side == "ssl"
                    else "buy-side stops above"
                )
                + " were just swept and rejected — the fuel for a move against this trade"
                " is spent."
            )
            if supportive_sweep
            else "No intact liquidity pool sits in the trade's immediate path."
        ),
    )

    extension = (
        abs(analytics.last_close - analytics.sma20) / analytics.atr14
        if analytics.sma20 and analytics.atr14
        else 0
    )
    extended = extension > 2.7
    add(
        "Extension from mean",
        "warning" if extended else "pass",
        _status_score("warning" if extended else "pass", 8, -6),
        f"Price is {_round(extension, 1)} ATR from the 20MA; chasing risk is elevated."
        if extended
        else "Price is not excessively extended from its 20-period mean.",
    )

    no_trade_reasons: list[str] = []
    if setup_type == "no-clear-setup":
        no_trade_reasons.append("No clear setup is classified.")
    if regime == "choppy":
        no_trade_reasons.append("Market regime is choppy/noisy.")
    if against_confirmed_trend:
        no_trade_reasons.append(f"Setup direction is against the confirmed {regime} regime.")
    # Fighting the swing structure is the same hard veto as fighting the regime.
    if structure_status == "fail":
        no_trade_reasons.append("Setup direction fights the swing-structure read.")
    if not rr_ok and direction != "none":
        no_trade_reasons.append("Reward/risk is below the configured minimum.")
    if near_resistance:
        no_trade_reasons.append("Price is too close to resistance for a long trade.")
    if near_support:
        no_trade_reasons.append("Price is too close to support for a short trade.")
    if pool_ahead:
        no_trade_reasons.append(
            "Long entry sits just below an intact buy-side liquidity pool."
            if direction == "long"
            else "Short entry sits just above an intact sell-side liquidity pool."
        )
    if not volume_ok:
        no_trade_reasons.append("Volume confirmation is missing.")
    if extended:
        no_trade_reasons.append(
            "Price is extended more than the configured ATR distance from mean."
        )
    if risk.position_size <= 0 and direction != "none":
        no_trade_reasons.append("Position size resolves to zero under current risk settings.")

    raw_confidence = sum(c.score for c in components) + 35
    confidence = int(max(0, min(100, _js_round(raw_confidence))))
    decision: TradeDecision = "wait"
    if (setup_type == "failed-breakout" or direction == "short") and (
        confidence >= 55 and not no_trade_reasons
    ):
        decision = "short-candidate"
    elif direction == "long" and confidence >= 55 and not no_trade_reasons:
        decision = "buy-candidate"
    elif no_trade_reasons:
        decision = "invalidated" if setup_type == "failed-breakout" else "no-trade"

    reason = (
        no_trade_reasons[0]
        if no_trade_reasons
        else (
            "A long candidate is forming with confirmed structure, acceptable reward/risk, "
            "and explainable support."
        )
        if decision == "buy-candidate"
        else "A short candidate is forming with bearish structure and acceptable risk controls."
        if decision == "short-candidate"
        else "The setup is not mature enough; wait for confirmation."
    )

    lean = directional_lean(direction, regime, structure)
    # Phase 1 instrumentation: the draw-on-liquidity read and the limit-at-POI
    # plan, read by nothing in the decision path. The setup direction leads;
    # when the engine refuses the setup the lean still names the side worth
    # mapping a draw for.
    objective_direction = direction if direction != "none" else lean
    objectives = (
        resolve_objectives(structure, liquidity, objective_direction, position_price)
        if objective_direction != "none" and position_price is not None
        else []
    )
    anticipatory_plan = (
        build_anticipatory_plan(
            zones, objective_direction, position_price, dealing_range, objectives
        )
        if objective_direction != "none" and position_price is not None
        else None
    )

    return SignalEvaluation(
        symbol=symbol,
        setup_type=setup_type,
        decision=decision,
        direction=direction,
        lean=lean,
        regime=regime,
        structure=structure,
        liquidity=liquidity,
        liquidity_sweeps=liquidity_sweeps,
        swing_strength=swing_strength,
        dealing_range=dealing_range,
        price_position=price_position,
        objectives=objectives,
        anticipatory_plan=anticipatory_plan,
        confidence=confidence,
        components=components,
        no_trade_reasons=no_trade_reasons,
        reason=reason,
        risk=risk,
        analytics=analytics,
        backtest=run_backtest(backtest_candles, settings, setup_type),
        strategy_version="QuantDeskSignal_v1",
        evaluated_at=datetime.now(tz=UTC).isoformat(),
    )


def run_backtest(
    candles: list[Candle],
    settings: RiskSettings = DEFAULT_RISK_SETTINGS,
    setup_type: SetupType = "no-clear-setup",
) -> BacktestSummary:
    trades: list[float] = []
    equity = 0.0
    peak = 0.0
    max_drawdown = 0.0
    direction = _decision_from_setup(setup_type)
    i = 55
    while direction != "none" and i < len(candles) - 5:
        window = candles[: i + 1]
        c = candles[i]
        # Replay-safe: compute pivots from only the bars available at this
        # point in time — no future-data leakage.
        window_pivots = compute_pivots(window)
        regime = classify_regime(window)
        setup = classify_setup(window, window_pivots, regime)
        if setup != setup_type:
            i += 1
            continue

        atr14 = atr(window, 14) or c.close * 0.02
        rr = max(settings.minimum_reward_risk, 1.8)
        stop = (
            c.close - atr14 * settings.atr_stop_multiplier
            if direction == "long"
            else c.close + atr14 * settings.atr_stop_multiplier
        )
        target = c.close + atr14 * rr if direction == "long" else c.close - atr14 * rr
        risk_per_unit = abs(c.close - stop)
        if risk_per_unit <= 0:
            i += 1
            continue

        r = 0.0
        for j in range(i + 1, min(len(candles), i + 11)):
            if direction == "long":
                if candles[j].low <= stop:
                    r = -1
                    break
                if candles[j].high >= target:
                    r = (target - c.close) / risk_per_unit
                    break
            else:
                if candles[j].high >= stop:
                    r = -1
                    break
                if candles[j].low <= target:
                    r = (c.close - target) / risk_per_unit
                    break
        if r == 0:
            exit_close = candles[min(len(candles) - 1, i + 10)].close
            r = (
                (exit_close - c.close) / risk_per_unit
                if direction == "long"
                else (c.close - exit_close) / risk_per_unit
            )
        trades.append(_round(r, 2))
        equity += r
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
        i += 1

    wins = [r for r in trades if r > 0]
    losses = [r for r in trades if r < 0]
    cw = 0
    cl = 0
    max_cw = 0
    max_cl = 0
    for r in trades:
        if r > 0:
            cw += 1
            cl = 0
        elif r < 0:
            cl += 1
            cw = 0
        max_cw = max(max_cw, cw)
        max_cl = max(max_cl, cl)
    average_win = _mean(wins) or 0
    average_loss_abs = abs(_mean(losses) or 0)
    win_rate = len(wins) / len(trades) if trades else 0
    loss_rate = len(losses) / len(trades) if trades else 0
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    return BacktestSummary(
        strategy_name=_humanize_setup(setup_type),
        strategy_version="SetupReplay_v2",
        total_trades=len(trades),
        win_rate=_round(win_rate * 100, 1),
        average_win=_round(average_win, 2),
        average_loss=_round(average_loss_abs, 2),
        profit_factor=(
            _round(gross_win / gross_loss, 2) if gross_loss > 0 else 99 if gross_win > 0 else 0
        ),
        expectancy=_round(win_rate * average_win - loss_rate * average_loss_abs, 2),
        max_drawdown=_round(max_drawdown, 2),
        average_r=_round(_mean(trades) or 0, 2),
        best_trade_r=_round(max(trades), 2) if trades else 0,
        worst_trade_r=_round(min(trades), 2) if trades else 0,
        consecutive_wins=max_cw,
        consecutive_losses=max_cl,
        low_sample=0 < len(trades) < MIN_RELIABLE_BACKTEST_TRADES,
    )
