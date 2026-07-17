"""The framework-free decision pipeline for one token.

This is the exact ``assess → record-adjust → reconcile-holds → open records``
sequence the TS client hook and server worker shared — lifted out so the
**worker** (the forward-test system of record) and any live view run one
identical code path. No I/O — pure in, pure out.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from smc.anticipatory import AnticipatorySignalDraft, build_anticipatory_signal
from smc.hysteresis import (
    DisplayIntentAssessment,
    HeldVerdict,
    iso_from_ms,
    reconcile_holds,
)
from smc.intent import ZonesByTimeframe, assess_intents
from smc.mock_candles import TokenTimeframe
from smc.perp import PerpRead
from smc.quant import SignalEvaluation
from smc.sessions import SessionLevel
from smc.shadow import (
    ShadowComboStat,
    ShadowSignalDraft,
    apply_record_adjustment,
    build_shadow_signal,
)
from smc.types import MarketType


@dataclass(slots=True)
class EvaluateInput:
    symbol: str
    market: MarketType
    evals_by_timeframe: dict[TokenTimeframe, SignalEvaluation]
    zones_by_timeframe: ZonesByTimeframe
    perp: PerpRead | None
    session_levels: list[SessionLevel]
    # Live shadow-record combo stats used to demote proven-negative setups.
    combo_stats: list[ShadowComboStat]
    # Standing verdict holds keyed by hold_key (the caller owns persistence).
    holds: dict[str, HeldVerdict]
    now_ms: float


@dataclass(slots=True)
class EvaluateOutput:
    # What the UI shows (verdicts after hysteresis + record adjustment).
    display: list[DisplayIntentAssessment]
    # Hold records that changed and must be persisted, keyed by hold_key.
    hold_updates: dict[str, HeldVerdict]
    # Newly-favored calls to open in the shadow record.
    shadow_to_open: list[ShadowSignalDraft] = field(default_factory=list)
    # Every displayed plan opens/refreshes an anticipatory fill record (EDR 0010).
    anticipatory_to_open: list[AnticipatorySignalDraft] = field(default_factory=list)


def evaluate_symbol(input_: EvaluateInput) -> EvaluateOutput | None:
    raw = assess_intents(
        input_.evals_by_timeframe,
        input_.zones_by_timeframe,
        input_.perp,
        input_.session_levels,
    )
    if not raw:
        return None

    entries = [apply_record_adjustment(assessment, input_.combo_stats) for assessment in raw]
    result = reconcile_holds(
        symbol=input_.symbol,
        market=input_.market,
        entries=entries,
        holds=input_.holds,
        now_ms=input_.now_ms,
    )

    now_iso = iso_from_ms(input_.now_ms)
    shadow_to_open = [
        draft
        for a in result.opened_favored
        if (draft := build_shadow_signal(a, input_.symbol, input_.market, now_iso)) is not None
    ]
    anticipatory_to_open = [
        ant_draft
        for a in result.display
        if (ant_draft := build_anticipatory_signal(a, input_.symbol, input_.market, now_iso))
        is not None
    ]

    return EvaluateOutput(
        display=result.display,
        hold_updates=result.updates,
        shadow_to_open=shadow_to_open,
        anticipatory_to_open=anticipatory_to_open,
    )
