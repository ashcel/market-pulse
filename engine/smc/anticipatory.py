"""Phase 0.5 — the limit-fill / no-fill harness over ``AnticipatoryPlan``.

A shadow record (shadow.py) grades calls that enter at the live price; an
anticipatory plan instead rests a limit at a POI below the market and may
simply never fill. Grading it honestly therefore needs a third outcome:
**never-filled is neither a win nor a loss** — it carries no R — and a fill
model must decide *when* the position exists before any stop/objective walk
can run. Records are kept in their own store, never mixed into the shadow
record's setup_type|regime combo stats. See
docs/decisions/0010-anticipatory-fill-model.md.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from smc.hysteresis import INTENT_MAX_HOLD_BARS, iso_from_ms, parse_iso_ms
from smc.intent import IntentAssessment, IntentVerdict, TradingIntent
from smc.mock_candles import STEP_SECONDS, TokenTimeframe
from smc.quant import MarketRegime, SetupType
from smc.strength import SwingStrength
from smc.types import Candle, MarketType
from smc.version import current_provenance

AnticipatorySignalStatus = Literal[
    "pending",  # limit resting, not yet filled
    "never-filled",  # horizon expired without a touch — its own graded outcome, no R
    "filled",  # position open, neither stop nor objective reached yet
    "objective-hit",
    "stopped-out",
    "expired",  # filled, then went nowhere within the hold window
]

_OPEN_STATUSES: tuple[AnticipatorySignalStatus, ...] = ("pending", "filled")


def is_open_anticipatory_status(status: AnticipatorySignalStatus) -> bool:
    return status in _OPEN_STATUSES


@dataclass(slots=True)
class AnticipatorySignal:
    id: str
    symbol: str
    market: MarketType
    intent: TradingIntent
    direction: Literal["long", "short"]
    # Execution-timeframe setup/regime at adoption — comparable to the shadow
    # record's cohorts.
    setup_type: SetupType
    regime: MarketRegime
    timeframe: TokenTimeframe
    # The verdict at adoption. Anticipation is recorded at *every* verdict
    # stage — a resting limit exists precisely while the trigger is still
    # unconfirmed.
    verdict: IntentVerdict
    # The limit price — the POI's proximal edge.
    entry: float
    # Beyond the POI's distal edge (EDR 0009).
    stop: float
    # The preferred draw-on-liquidity objective's price (EDR 0008).
    objective: float
    objective_strength: SwingStrength
    zone_freshness: Literal["fresh", "tested"]
    # Planned RR from the limit, frozen at adoption.
    reward_risk: float
    opened_at: str
    status: AnticipatorySignalStatus
    # Open time (ISO) of the closed bar that touched the limit.
    filled_at: str | None = None
    closed_at: str | None = None
    close_price: float | None = None
    # Realized R measured from the limit; None for never-filled — no position, no R.
    result_r: float | None = None
    # Provenance — which engine version / config / commit produced this record.
    engine_version: str | None = None
    config_hash: str | None = None
    git_sha: str | None = None


@dataclass(slots=True)
class AnticipatorySignalDraft:
    """An anticipatory record ready to open — everything but id/status."""

    symbol: str
    market: MarketType
    intent: TradingIntent
    direction: Literal["long", "short"]
    setup_type: SetupType
    regime: MarketRegime
    timeframe: TokenTimeframe
    verdict: IntentVerdict
    entry: float
    stop: float
    objective: float
    objective_strength: SwingStrength
    zone_freshness: Literal["fresh", "tested"]
    reward_risk: float
    opened_at: str
    engine_version: str
    config_hash: str
    git_sha: str


def _round(value: float, digits: int = 2) -> float:
    scale = 10.0**digits
    return math.floor(value * scale + 0.5) / scale


def build_anticipatory_signal(
    assessment: IntentAssessment, symbol: str, market: MarketType, now_iso: str
) -> AnticipatorySignalDraft | None:
    """Builds the record for an assessment whose anticipatory plan should
    start being graded; None when the assessment has no plan. The record
    freezes the plan at adoption — a resting limit stays where it was placed;
    if the derived plan later moves, the next record (after this one settles)
    grades the new one."""
    plan = assessment.anticipatory_plan
    if plan is None:
        return None
    provenance = current_provenance()
    return AnticipatorySignalDraft(
        symbol=symbol.upper(),
        market=market,
        intent=assessment.intent,
        direction=plan.direction,
        setup_type=assessment.execution.setup_type,
        regime=assessment.execution.regime,
        timeframe=assessment.definition.execution_timeframe,
        verdict=assessment.verdict,
        entry=plan.entry,
        stop=plan.stop,
        objective=plan.objective.price,
        objective_strength=plan.objective.strength,
        zone_freshness=plan.zone.freshness,
        reward_risk=_round(plan.reward_risk),
        opened_at=now_iso,
        engine_version=provenance.engine_version,
        config_hash=provenance.config_hash,
        git_sha=provenance.git_sha,
    )


@dataclass(slots=True)
class AnticipatorySettlePatch:
    """The next patch to merge into an anticipatory record; fields are None
    when the pass didn't decide them."""

    status: AnticipatorySignalStatus
    filled_at: str | None = None
    closed_at: str | None = None
    close_price: float | None = None
    result_r: float | None = None


def _walk_filled_position(
    signal: AnticipatorySignal,
    bars: list[Candle],
    first_is_fill_bar: bool,
    max_bars: int,
    step: int,
) -> AnticipatorySettlePatch | None:
    """Walks the filled position over closed bars, the fill bar first. Within
    a bar the stop is checked before the objective (the walk_exit_levels
    convention). The fill bar itself is asymmetric: only the stop can resolve
    on it — the bar was travelling *into* the limit, so a same-bar stop print
    is plausible continuation, while a same-bar objective print may have
    happened before the fill existed and gets no credit (EDR 0010)."""
    long = signal.direction == "long"
    risk_per_unit = abs(signal.entry - signal.stop)

    def result_r(exit_: float) -> float:
        if risk_per_unit <= 0:
            return 0
        gain = exit_ - signal.entry if long else signal.entry - exit_
        return _round(gain / risk_per_unit)

    def closed_at_of(bar_time: int) -> str:
        return iso_from_ms((bar_time + step) * 1000)

    window = bars[:max_bars]
    for i, bar in enumerate(window):
        if bar.low <= signal.stop if long else bar.high >= signal.stop:
            return AnticipatorySettlePatch(
                status="stopped-out",
                close_price=signal.stop,
                closed_at=closed_at_of(bar.time),
                result_r=result_r(signal.stop),
            )
        if i == 0 and first_is_fill_bar:
            continue
        if bar.high >= signal.objective if long else bar.low <= signal.objective:
            return AnticipatorySettlePatch(
                status="objective-hit",
                close_price=signal.objective,
                closed_at=closed_at_of(bar.time),
                result_r=result_r(signal.objective),
            )

    if len(window) >= max_bars:
        last = window[max_bars - 1]
        return AnticipatorySettlePatch(
            status="expired",
            close_price=last.close,
            closed_at=closed_at_of(last.time),
            result_r=result_r(last.close),
        )
    return None


def settle_anticipatory_signal(
    signal: AnticipatorySignal, closed_bars: list[Candle]
) -> AnticipatorySettlePatch | None:
    """Settles one anticipatory record against closed bars. Re-entrant: called
    repeatedly as new bars close, it returns the next patch to merge or None
    when nothing changed, and a patch it has issued can never be contradicted
    by later data (fills and level touches cannot un-happen; horizons only
    complete once).

    Pending: the first closed bar after adoption whose range touches the limit
    (inclusive) fills it — first-touch-decides, fill modeled at the limit
    price exactly. No touch within the intent's holding horizon closes the
    record "never-filled" with no R. On a fill the position walk continues in
    the same pass, so a single settlement can move pending → stopped-out."""
    opened_at_sec = parse_iso_ms(signal.opened_at) / 1000
    if not math.isfinite(opened_at_sec):
        return None
    max_bars = INTENT_MAX_HOLD_BARS[signal.intent]
    step = STEP_SECONDS[signal.timeframe]
    long = signal.direction == "long"

    def touches_limit(bar: Candle) -> bool:
        return bar.low <= signal.entry if long else bar.high >= signal.entry

    if signal.status == "pending":
        bars = [c for c in closed_bars if c.time > opened_at_sec][:max_bars]
        fill_index = next((i for i, bar in enumerate(bars) if touches_limit(bar)), -1)
        if fill_index == -1:
            if len(bars) >= max_bars:
                return AnticipatorySettlePatch(
                    status="never-filled",
                    closed_at=iso_from_ms((bars[max_bars - 1].time + step) * 1000),
                )
            return None  # still resting
        filled_at = iso_from_ms(bars[fill_index].time * 1000)
        # The position walk sees every bar from the fill onward — its horizon
        # is max_bars from the fill, not from adoption, so a filled
        # anticipatory record gets the same hold window a shadow record does.
        position_bars = [c for c in closed_bars if c.time >= bars[fill_index].time]
        outcome = _walk_filled_position(signal, position_bars, True, max_bars, step)
        if outcome is not None:
            outcome.filled_at = filled_at
            return outcome
        return AnticipatorySettlePatch(status="filled", filled_at=filled_at)

    if signal.status == "filled":
        filled_at_sec = (
            parse_iso_ms(signal.filled_at) / 1000 if signal.filled_at is not None else math.nan
        )
        if not math.isfinite(filled_at_sec):
            return None
        bars = [c for c in closed_bars if c.time >= filled_at_sec]
        if not bars:
            return None
        # The fill-bar asymmetry only applies when the batch actually starts
        # at the fill bar; a shorter fetch window starting later walks
        # normally.
        return _walk_filled_position(
            signal, bars, bars[0].time == filled_at_sec, max_bars, step
        )

    return None  # terminal


@dataclass(slots=True)
class AnticipatoryRecordSummary:
    total: int
    # Limits still resting.
    pending: int
    # Positions filled and still open.
    open: int
    never_filled: int
    # Filled records, settled or not.
    filled: int
    # filled ÷ (filled + never_filled) — how often the pullback actually comes.
    fill_rate: float
    settled: int
    wins: int
    losses: int
    win_rate: float
    # Average R over settled positions only — never-filled carries no R by design.
    average_r: float
    low_sample: bool


# Below this many settled positions the record is noise, not evidence (same
# bar as shadow).
MIN_ANTICIPATORY_RECORD_TRADES = 15


def summarize_anticipatory_record(
    signals: list[AnticipatorySignal],
) -> AnticipatoryRecordSummary:
    pending = [s for s in signals if s.status == "pending"]
    open_ = [s for s in signals if s.status == "filled"]
    never_filled = [s for s in signals if s.status == "never-filled"]
    settled = [s for s in signals if s.status in ("objective-hit", "stopped-out", "expired")]
    filled = len(open_) + len(settled)
    fill_decided = filled + len(never_filled)
    wins = [s for s in settled if (s.result_r if s.result_r is not None else 0) > 0]
    losses = [s for s in settled if s.status == "stopped-out"]
    r_values = [s.result_r if s.result_r is not None else 0 for s in settled]
    average_r = sum(r_values) / len(r_values) if r_values else 0

    return AnticipatoryRecordSummary(
        total=len(signals),
        pending=len(pending),
        open=len(open_),
        never_filled=len(never_filled),
        filled=filled,
        fill_rate=_round(filled / fill_decided * 100, 1) if fill_decided else 0,
        settled=len(settled),
        wins=len(wins),
        losses=len(losses),
        win_rate=_round(len(wins) / len(settled) * 100, 1) if settled else 0,
        average_r=_round(average_r),
        low_sample=0 < len(settled) < MIN_ANTICIPATORY_RECORD_TRADES,
    )
