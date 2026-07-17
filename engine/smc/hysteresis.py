"""Verdict hysteresis: a verdict holds until its own release condition fires.

A discretionary trader doesn't re-derive their thesis on every tick — they
form a view and hold it until something specific breaks it. The raw engine
re-evaluates from scratch on each refetch, so regime and pivot wobble can flip
a verdict without price actually doing anything. This layer persists the last
adopted verdict per symbol/market/intent and only lets it change when one of
its own release conditions fires:

1. upgrade      — the same-direction idea got *more* confirmed (wait → favored)
2. invalidation — a closed execution-timeframe candle broke the level the
                  verdict itself named as its invalidation
3. context flip — the higher-timeframe trend the verdict leaned on changed
4. staleness    — the read aged past the intent's holding horizon
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, fields
from datetime import UTC, datetime
from typing import Literal

from smc.intent import IntentAssessment, IntentVerdict, TradingIntent
from smc.mock_candles import STEP_SECONDS, TokenTimeframe
from smc.quant import RiskRewardPlan, SetupType, TradeDirection
from smc.types import MarketType

# How many execution-timeframe bars a verdict may be held before it ages out.
INTENT_MAX_HOLD_BARS: dict[TradingIntent, int] = {
    "scalp": 16,  # 15M bars ≈ 4 hours
    "intraday": 24,  # 1H bars ≈ 1 day
    "swing": 42,  # 4H bars ≈ 1 week
    "position": 30,  # 1D bars ≈ 1 month
}


@dataclass(slots=True)
class TriggerLevel:
    """A closed-candle price level whose break is a machine-checkable trigger."""

    level: float
    side: Literal["below", "above"]


@dataclass(slots=True)
class HeldVerdict:
    symbol: str
    market: MarketType
    # Execution timeframe the verdict's trigger levels live on.
    execution_timeframe: TokenTimeframe
    intent: TradingIntent
    verdict: IntentVerdict
    direction: TradeDirection
    is_counter_trend: bool
    size_multiplier: float
    headline: str
    summary: str
    triggers: list[str]
    confidence: float
    plan: RiskRewardPlan | None
    # Execution-timeframe setup at adoption time (feeds the shadow record).
    setup_type: SetupType
    # Context-timeframe lean the verdict was built on; a flip releases the hold.
    context_bias: TradeDirection
    held_at: str
    # Closed execution-candle level that releases this hold when broken.
    invalidation: TriggerLevel | None
    # Closed execution-candle level whose break would strengthen/confirm the
    # verdict (resistance for a long, support for a short). Drives "trigger
    # hit" upgrade alerts while the verdict is still wait/caution.
    upgrade_trigger: TriggerLevel | None
    # Why this hold replaced the previous one — shown once in the UI.
    adopted_because: str | None = None


@dataclass(slots=True)
class RecordNote:
    """Live shadow-record evidence attached to a verdict."""

    note: str
    # True when the note explains an automatic favored → caution demotion.
    demoted: bool


@dataclass(slots=True)
class HoldInfo:
    held_at: str
    is_held: bool
    adopted_because: str | None = None


def _unset_hold() -> HoldInfo:
    return HoldInfo(held_at="", is_held=False)


@dataclass(slots=True)
class DisplayIntentAssessment(IntentAssessment):
    """The assessment the UI renders: fresh context, held verdict, hold metadata."""

    hold: HoldInfo = field(default_factory=_unset_hold)
    record: RecordNote | None = None


@dataclass(slots=True)
class ReconcileEntry:
    """A fresh assessment after the shadow-record adjustment pass."""

    assessment: IntentAssessment
    record: RecordNote | None = None
    # True when the raw verdict was "favored" before any record demotion.
    favored_before_adjustment: bool = False


def hold_key(symbol: str, market: MarketType, intent: TradingIntent) -> str:
    return f"{symbol.upper()}:{market}:{intent}"


_VERDICT_RANK: dict[IntentVerdict, int] = {"avoid": 0, "wait": 1, "caution": 2, "favored": 3}


def _fmt_level(value: float) -> str:
    abs_ = abs(value)
    if abs_ >= 1000:
        text = f"{value:,.2f}".rstrip("0").rstrip(".")
        return f"${text}"
    if abs_ >= 1:
        text = f"{value:,.4f}".rstrip("0").rstrip(".")
        return f"${text}"
    return f"${value:.5g}"


def parse_iso_ms(iso: str) -> float:
    """Date.parse equivalent: epoch ms, or NaN on garbage."""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return math.nan


def iso_from_ms(ms: float) -> str:
    """new Date(ms).toISOString() equivalent (millisecond precision, Z suffix)."""
    return (
        datetime.fromtimestamp(ms / 1000, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _capture_hold(
    assessment: IntentAssessment,
    symbol: str,
    market: MarketType,
    now_ms: float,
    adopted_because: str | None = None,
) -> HeldVerdict:
    a = assessment.execution.analytics
    invalidation: TriggerLevel | None = None
    upgrade_trigger: TriggerLevel | None = None
    if assessment.direction == "long":
        inv_level = a.support if a.support is not None else assessment.execution.risk.invalidation
        if math.isfinite(inv_level):
            invalidation = TriggerLevel(level=inv_level, side="below")
        if a.resistance is not None and math.isfinite(a.resistance):
            upgrade_trigger = TriggerLevel(level=a.resistance, side="above")
    elif assessment.direction == "short":
        inv_level = (
            a.resistance if a.resistance is not None else assessment.execution.risk.invalidation
        )
        if math.isfinite(inv_level):
            invalidation = TriggerLevel(level=inv_level, side="above")
        if a.support is not None and math.isfinite(a.support):
            upgrade_trigger = TriggerLevel(level=a.support, side="below")

    return HeldVerdict(
        symbol=symbol.upper(),
        market=market,
        execution_timeframe=assessment.definition.execution_timeframe,
        intent=assessment.intent,
        verdict=assessment.verdict,
        direction=assessment.direction,
        is_counter_trend=assessment.is_counter_trend,
        size_multiplier=assessment.size_multiplier,
        headline=assessment.headline,
        summary=assessment.summary,
        triggers=assessment.triggers,
        confidence=assessment.confidence,
        plan=assessment.plan,
        setup_type=assessment.execution.setup_type,
        context_bias=assessment.context_bias,
        held_at=iso_from_ms(now_ms),
        invalidation=invalidation,
        upgrade_trigger=upgrade_trigger,
        adopted_because=adopted_because,
    )


@dataclass(slots=True)
class _Release:
    """Why an existing hold must be released; None from the caller means it stands."""

    note: str | None = None


def _release_reason(
    held: HeldVerdict, fresh: IntentAssessment, now_ms: float
) -> _Release | None:
    definition = fresh.definition
    held_at_ms = parse_iso_ms(held.held_at)
    max_age_ms = (
        INTENT_MAX_HOLD_BARS[held.intent] * STEP_SECONDS[definition.execution_timeframe] * 1000
    )
    if not math.isfinite(held_at_ms) or now_ms - held_at_ms > max_age_ms:
        return _Release()

    if held.invalidation is not None:
        last_close = fresh.execution.analytics.last_close
        broken = (
            last_close < held.invalidation.level
            if held.invalidation.side == "below"
            else last_close > held.invalidation.level
        )
        if broken:
            return _Release(
                note=(
                    f"{definition.execution_timeframe} closed {held.invalidation.side} "
                    f'{_fmt_level(held.invalidation.level)}, releasing the prior '
                    f'"{held.headline}" read.'
                )
            )

    if fresh.context_bias != "none" and fresh.context_bias != held.context_bias:
        return _Release(
            note=(
                f"The {definition.context_timeframe} trend now leans {fresh.context_bias} — "
                "the context this verdict was built on changed."
            )
        )

    upgrade = _VERDICT_RANK[fresh.verdict] > _VERDICT_RANK[held.verdict] and (
        held.direction == "none" or fresh.direction == held.direction
    )
    if upgrade:
        if fresh.verdict == "favored":
            return _Release(note=f'Confirmation completed — upgraded from "{held.verdict}".')
        return _Release()

    return None


def _assessment_kwargs(fresh: IntentAssessment) -> dict[str, object]:
    return {f.name: getattr(fresh, f.name) for f in fields(IntentAssessment)}


def _display_from_hold(
    held: HeldVerdict, fresh: IntentAssessment, record: RecordNote | None
) -> DisplayIntentAssessment:
    """Rebuilds the display assessment from a standing hold + fresh context."""
    kwargs = _assessment_kwargs(fresh)
    kwargs.update(
        verdict=held.verdict,
        direction=held.direction,
        is_counter_trend=held.is_counter_trend,
        size_multiplier=held.size_multiplier,
        headline=held.headline,
        summary=held.summary,
        triggers=held.triggers,
        confidence=held.confidence,
        plan=held.plan,
    )
    return DisplayIntentAssessment(
        **kwargs,  # type: ignore[arg-type]
        hold=HoldInfo(held_at=held.held_at, is_held=True, adopted_because=held.adopted_because),
        record=record,
    )


@dataclass(slots=True)
class ReconcileResult:
    display: list[DisplayIntentAssessment]
    # Hold records that changed and must be persisted (keyed by hold_key).
    updates: dict[str, HeldVerdict]
    # Newly adopted verdicts that were favored pre-adjustment — shadow-record
    # candidates.
    opened_favored: list[IntentAssessment]


def reconcile_holds(
    symbol: str,
    market: MarketType,
    entries: list[ReconcileEntry],
    holds: dict[str, HeldVerdict],
    now_ms: float,
) -> ReconcileResult:
    display: list[DisplayIntentAssessment] = []
    updates: dict[str, HeldVerdict] = {}
    opened_favored: list[IntentAssessment] = []

    for entry in entries:
        fresh = entry.assessment
        key = hold_key(symbol, market, fresh.intent)
        held = holds.get(key)
        release = _release_reason(held, fresh, now_ms) if held is not None else _Release()

        if held is not None and release is None:
            display.append(_display_from_hold(held, fresh, entry.record))
            continue

        note = release.note if release is not None else None
        adopted = _capture_hold(fresh, symbol, market, now_ms, note)
        updates[key] = adopted
        if entry.favored_before_adjustment:
            opened_favored.append(fresh)
        display.append(
            DisplayIntentAssessment(
                **_assessment_kwargs(fresh),  # type: ignore[arg-type]
                hold=HoldInfo(
                    held_at=adopted.held_at,
                    is_held=False,
                    adopted_because=adopted.adopted_because,
                ),
                record=entry.record,
            )
        )

    return ReconcileResult(display=display, updates=updates, opened_favored=opened_favored)
