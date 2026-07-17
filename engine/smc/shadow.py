"""Shadow record: every "favored" verdict is auto-recorded and settled.

Nothing is cherry-picked and the user doesn't have to follow a call for it to
count. The resulting per-setup/per-regime hit rates are the engine's live
accountability, and combos with a proven negative record demote future
"favored" verdicts. Ported verbatim from the TS engine's ``shadow.ts``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Literal

from smc.hysteresis import (
    INTENT_MAX_HOLD_BARS,
    ReconcileEntry,
    RecordNote,
    iso_from_ms,
    parse_iso_ms,
)
from smc.intent import IntentAssessment, TradingIntent, scale_plan
from smc.mock_candles import STEP_SECONDS, TokenTimeframe
from smc.quant import MarketRegime, SetupType
from smc.tracker import ExitLevels, walk_exit_levels
from smc.types import Candle, MarketType
from smc.version import current_provenance

ShadowSignalStatus = Literal["active", "target1-hit", "target2-hit", "stopped-out", "expired"]


@dataclass(slots=True)
class ShadowSignal:
    id: str
    symbol: str
    market: MarketType
    intent: TradingIntent
    direction: Literal["long", "short"]
    setup_type: SetupType
    # Execution-timeframe regime when the call was made.
    regime: MarketRegime
    timeframe: TokenTimeframe
    entry: float
    stop: float
    target1: float
    target2: float
    confidence: float
    opened_at: str
    status: ShadowSignalStatus
    closed_at: str | None = None
    close_price: float | None = None
    result_r: float | None = None
    # Whether a clean draw-on-liquidity objective existed for the call's
    # direction when it was adopted (Phase 1 annotation; EDR 0008). Keys
    # nothing — records predating the field settle unchanged.
    objective_resolved: bool | None = None
    # Provenance — which engine version / config / commit produced this
    # record. None on records predating provenance; those are excluded from
    # current-version stats.
    engine_version: str | None = None
    config_hash: str | None = None
    git_sha: str | None = None


@dataclass(slots=True)
class ShadowSignalDraft:
    """A shadow record ready to open — everything but the store-assigned id/status."""

    symbol: str
    market: MarketType
    intent: TradingIntent
    direction: Literal["long", "short"]
    setup_type: SetupType
    regime: MarketRegime
    timeframe: TokenTimeframe
    entry: float
    stop: float
    target1: float
    target2: float
    confidence: float
    opened_at: str
    objective_resolved: bool
    engine_version: str
    config_hash: str
    git_sha: str


# Below this many settled shadow trades a combo's record is noise, not evidence.
MIN_SHADOW_RECORD_TRADES = 15


def _round(value: float, digits: int = 2) -> float:
    scale = 10.0**digits
    return math.floor(value * scale + 0.5) / scale


def _humanize(value: str) -> str:
    return value.replace("-", " ")


def build_shadow_signal(
    assessment: IntentAssessment, symbol: str, market: MarketType, now_iso: str
) -> ShadowSignalDraft | None:
    """Builds the shadow record entry for a newly adopted favored verdict."""
    plan = assessment.plan
    if plan is None or assessment.direction not in ("long", "short"):
        return None
    provenance = current_provenance()
    return ShadowSignalDraft(
        symbol=symbol.upper(),
        market=market,
        intent=assessment.intent,
        direction=assessment.direction,
        setup_type=assessment.execution.setup_type,
        regime=assessment.execution.regime,
        timeframe=assessment.definition.execution_timeframe,
        entry=plan.entry,
        stop=plan.stop,
        target1=plan.target1,
        target2=plan.target2,
        confidence=assessment.confidence,
        opened_at=now_iso,
        objective_resolved=len(assessment.execution.objectives) > 0,
        engine_version=provenance.engine_version,
        config_hash=provenance.config_hash,
        git_sha=provenance.git_sha,
    )


@dataclass(slots=True)
class ShadowSettlePatch:
    status: ShadowSignalStatus
    close_price: float
    closed_at: str
    result_r: float


def settle_shadow_signal(
    signal: ShadowSignal, closed_bars: list[Candle]
) -> ShadowSettlePatch | None:
    """Settles one shadow signal against closed bars: first-touch-wins on
    highs/lows (stop checked first within a bar), and a time stop — a call
    that hits nothing within the intent's holding horizon closes as "expired"
    at that bar's close, because "went nowhere" is also a graded outcome."""
    if signal.status != "active":
        return None
    opened_at_sec = parse_iso_ms(signal.opened_at) / 1000
    if not math.isfinite(opened_at_sec):
        return None

    max_bars = INTENT_MAX_HOLD_BARS[signal.intent]
    bars = [c for c in closed_bars if c.time > opened_at_sec][:max_bars]
    step = STEP_SECONDS[signal.timeframe]

    def closed_at_of(bar_time: int) -> str:
        return iso_from_ms((bar_time + step) * 1000)

    exit_ = walk_exit_levels(
        ExitLevels(
            direction=signal.direction,
            entry=signal.entry,
            stop=signal.stop,
            target1=signal.target1,
            target2=signal.target2,
        ),
        bars,
    )
    if exit_ is not None:
        return ShadowSettlePatch(
            status=exit_.status,
            close_price=exit_.exit_level,
            closed_at=closed_at_of(exit_.bar_time),
            result_r=exit_.result_r,
        )

    if len(bars) >= max_bars:
        last_bar = bars[max_bars - 1]
        risk_per_unit = abs(signal.entry - signal.stop)
        if risk_per_unit > 0:
            gain = (
                last_bar.close - signal.entry
                if signal.direction == "long"
                else signal.entry - last_bar.close
            )
            result_r = _round(gain / risk_per_unit)
        else:
            result_r = 0
        return ShadowSettlePatch(
            status="expired",
            close_price=last_bar.close,
            closed_at=closed_at_of(last_bar.time),
            result_r=result_r,
        )

    return None


@dataclass(slots=True)
class ShadowRecordSummary:
    total: int
    open: int
    closed: int
    wins: int
    win_rate: float
    average_r: float
    low_sample: bool


def summarize_shadow_record(signals: list[ShadowSignal]) -> ShadowRecordSummary:
    closed = [s for s in signals if s.status != "active"]
    wins = [s for s in closed if (s.result_r if s.result_r is not None else 0) > 0]
    r_values = [s.result_r if s.result_r is not None else 0 for s in closed]
    average_r = sum(r_values) / len(r_values) if r_values else 0
    return ShadowRecordSummary(
        total=len(signals),
        open=len(signals) - len(closed),
        closed=len(closed),
        wins=len(wins),
        win_rate=_round(len(wins) / len(closed) * 100, 1) if closed else 0,
        average_r=_round(average_r),
        low_sample=0 < len(closed) < MIN_SHADOW_RECORD_TRADES,
    )


@dataclass(slots=True)
class ShadowComboStat:
    setup_type: SetupType
    regime: MarketRegime
    closed: int
    win_rate: float
    average_r: float
    # True when the sample is large enough and expectancy is negative.
    demoted: bool


def shadow_combo_stats(
    signals: list[ShadowSignal], engine_version: str | None = None
) -> list[ShadowComboStat]:
    """Live record per setup-type x regime combo, most-traded first. When
    ``engine_version`` is given the record is segmented to that engine — the
    whole point of provenance. Omit it (tests, aggregate views) to pool every
    version."""
    scoped = (
        signals
        if engine_version is None
        else [s for s in signals if s.engine_version == engine_version]
    )
    buckets: dict[str, tuple[SetupType, MarketRegime, list[float]]] = {}
    for s in scoped:
        if s.status == "active":
            continue
        key = f"{s.setup_type}|{s.regime}"
        bucket = buckets.setdefault(key, (s.setup_type, s.regime, []))
        bucket[2].append(s.result_r if s.result_r is not None else 0)

    stats: list[ShadowComboStat] = []
    for setup_type, regime, r_values in buckets.values():
        wins = sum(1 for r in r_values if r > 0)
        average_r = _round(sum(r_values) / len(r_values))
        stats.append(
            ShadowComboStat(
                setup_type=setup_type,
                regime=regime,
                closed=len(r_values),
                win_rate=_round(wins / len(r_values) * 100, 1),
                average_r=average_r,
                demoted=len(r_values) >= MIN_SHADOW_RECORD_TRADES and average_r < 0,
            )
        )
    return sorted(stats, key=lambda s: -s.closed)


def apply_record_adjustment(
    assessment: IntentAssessment, combo_stats: list[ShadowComboStat]
) -> ReconcileEntry:
    """The accountability loop: a "favored" verdict whose setup/regime combo
    has a proven negative live record is demoted to caution at half size — the
    engine stops recommending full size on trades it demonstrably loses.
    Combos with a meaningful record also get an evidence note either way."""
    favored_before_adjustment = assessment.verdict == "favored"
    combo = next(
        (
            s
            for s in combo_stats
            if s.setup_type == assessment.execution.setup_type
            and s.regime == assessment.execution.regime
        ),
        None,
    )
    if combo is None or combo.closed < MIN_SHADOW_RECORD_TRADES:
        return ReconcileEntry(
            assessment=assessment, favored_before_adjustment=favored_before_adjustment
        )

    setup_label = _humanize(assessment.execution.setup_type)
    regime_label = _humanize(assessment.execution.regime)
    sign = "+" if combo.average_r >= 0 else ""
    signed_r = f"{sign}{combo.average_r:g}R"

    if favored_before_adjustment and combo.demoted:
        return ReconcileEntry(
            assessment=replace(
                assessment,
                verdict="caution",
                size_multiplier=0.5,
                plan=scale_plan(assessment.plan, 0.5) if assessment.plan is not None else None,
                headline=f"{assessment.headline} — demoted by live record",
                summary=(
                    f"{assessment.summary} However, the engine's own shadow record for this "
                    "exact situation is negative — treat it as a half-size trade at best."
                ),
            ),
            record=RecordNote(
                note=(
                    f"Auto-demoted: shadow-tracked {setup_label} calls in a {regime_label} "
                    f"tape average {signed_r} over {combo.closed} settled trades."
                ),
                demoted=True,
            ),
            favored_before_adjustment=favored_before_adjustment,
        )

    return ReconcileEntry(
        assessment=assessment,
        record=RecordNote(
            note=(
                f"Live shadow record for {setup_label} in a {regime_label} tape: "
                f"{combo.win_rate:g}% win rate, {signed_r} avg over {combo.closed} settled "
                "trades."
            ),
            demoted=False,
        ),
        favored_before_adjustment=favored_before_adjustment,
    )
