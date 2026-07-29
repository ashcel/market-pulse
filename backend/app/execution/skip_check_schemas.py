"""Skip Check contract — R2 (EDR 0022 decision 5, re-anchored M6).

The Skip Check is the product's thesis surface: before risking capital the
user gets a *deterministic* answer to "is this trade good?" assembled from the
already-built risk desk (constitution + sizing + risk engine), the engine's
per-objective verdict, the catalyst-impact window, and the deterministic
behavior detectors — **no order intent, nothing persisted, no AI in the
decision path.**

This module is the typed response contract. It deliberately has **no
free-text claim path**: every claim the surface makes is a typed `SkipCode`
on a typed `SkipBlockKind`; the string fields (`headline`, `detail`,
`condition`) are deterministic templates rendered from those enums and are
*context only, never load-bearing* — exactly the convention
`risk_engine.PermitCheckResult.detail` already follows. Blocks below the
evidence bar render as first-class "no opinion — insufficient evidence"
(`BlockStatus.NO_OPINION`), which the original M6 spec treats as a feature,
not a gap.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field

# ── request ────────────────────────────────────────────────────────────────


class SkipObjective(StrEnum):
    SCALP = "scalp"
    INTRADAY = "intraday"
    SWING = "swing"
    POSITION = "position"


class SkipDirection(StrEnum):
    LONG = "LONG"
    SHORT = "SHORT"


class VerdictState(StrEnum):
    """Per-objective verdict state from the shared SMC engine (the same
    framework-free pipeline the browser runs). Deterministic, never AI."""

    LIVE = "live"
    NOT_YET = "not_yet"
    WRONG_STRATEGY = "wrong_strategy"
    UNKNOWN = "unknown"


class VerdictContextInput(BaseModel):
    """Engine-derived verdict context, optionally supplied by the caller.

    The per-objective verdict is computed by the deterministic SMC engine
    (`src/lib/engine`), which runs in the browser as a read-only view. It is
    *not* account state and *not* AI output, so it is safe to pass through —
    when omitted, the objective-fit block renders "no opinion — insufficient
    evidence" rather than inventing a read.
    """

    state: VerdictState
    regime: str | None = None
    regime_aligned: bool | None = None
    flip_condition: str | None = None


class SkipCheckRequest(BaseModel):
    """Skip Check intake — a proposal WITHOUT order intent.

    Note the shape mirrors a ticket minus quantity (never a user input, EDR
    0020) and minus a persisted-permit's account fields (fetched server-side).
    `planned_stop` / `take_profit` are optional: their absence produces a
    first-class "no opinion" on the checks that need them, never a guessed
    value.
    """

    symbol: str
    objective: SkipObjective
    direction: SkipDirection
    entry_price: Decimal | None = Field(default=None, gt=0)
    planned_stop: Decimal | None = Field(default=None, gt=0)
    take_profit: Decimal | None = Field(default=None, gt=0)
    risk_percent: Decimal | None = Field(default=None, ge=0.5, le=3.0)
    leverage: Decimal | None = Field(default=None, ge=1, le=125)
    margin_type: str = Field(default="ISOLATED", pattern=r"^(ISOLATED|CROSSED)$")
    correlation_bucket: str = "other"
    verdict: VerdictContextInput | None = None


# ── typed answer blocks ────────────────────────────────────────────────────


class BlockStatus(StrEnum):
    SUPPORTIVE = "supportive"
    CAUTION = "caution"
    NO_OPINION = "no_opinion"


class SkipAnswer(StrEnum):
    SUPPORTIVE = "supportive"
    CAUTION = "caution"
    NO_OPINION = "no_opinion"


class SkipBlockKind(StrEnum):
    CONSTITUTION_HEADROOM = "constitution_headroom"
    LOSS_BUDGET = "loss_budget"
    PORTFOLIO_EXPOSURE = "portfolio_exposure"
    ACCOUNT_STATE = "account_state"
    RISK_REWARD = "risk_reward"
    LIQUIDATION_BUFFER = "liquidation_buffer"
    BEHAVIOR = "behavior"
    OBJECTIVE_FIT = "objective_fit"
    REGIME_FIT = "regime_fit"
    CATALYST_WINDOW = "catalyst_window"


class SkipCode(StrEnum):
    # supportive
    ALL_LIMITS_CLEAR = "all_limits_clear"
    LOSS_BUDGET_ROOM = "loss_budget_room"
    EXPOSURE_ROOM = "exposure_room"
    ACCOUNT_FRESH = "account_fresh"
    RR_MEETS_MIN = "rr_meets_min"
    LIQ_BEYOND_STOP = "liq_beyond_stop"
    NO_BEHAVIOR_FLAGS = "no_behavior_flags"
    VERDICT_LIVE = "verdict_live"
    REGIME_ALIGNED = "regime_aligned"
    NO_ADVERSE_CATALYST = "no_adverse_catalyst"
    # caution
    CONSTITUTION_LIMIT_HIT = "constitution_limit_hit"
    LOSS_BUDGET_EXHAUSTED = "loss_budget_exhausted"
    EXPOSURE_EXCEEDED = "exposure_exceeded"
    ACCOUNT_STALE = "account_stale"
    RR_BELOW_MIN = "rr_below_min"
    LIQ_INSIDE_STOP = "liq_inside_stop"
    BEHAVIOR_ADVISORY = "behavior_advisory"
    BEHAVIOR_BINDING = "behavior_binding"
    VERDICT_NOT_YET = "verdict_not_yet"
    VERDICT_WRONG_STRATEGY = "verdict_wrong_strategy"
    REGIME_MISALIGNED = "regime_misaligned"
    ADVERSE_CATALYST = "adverse_catalyst"
    # no opinion — insufficient evidence, first-class
    STOP_NOT_PROVIDED = "stop_not_provided"
    TARGET_NOT_PROVIDED = "target_not_provided"
    LIQ_NOT_APPLICABLE = "liq_not_applicable"
    NO_VERDICT_SUPPLIED = "no_verdict_supplied"
    PRICE_UNAVAILABLE = "price_unavailable"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"


class EvidenceItem(BaseModel):
    label: str
    value: str


class SkipBlock(BaseModel):
    """One typed line of the answer. `code` (enum) is load-bearing; `headline`
    / `detail` are deterministic templates, context only."""

    kind: SkipBlockKind
    status: BlockStatus
    code: SkipCode
    headline: str
    detail: str
    blocking: bool = False
    evidence: list[EvidenceItem] = Field(default_factory=list)


class WhatFlipsItItem(BaseModel):
    kind: SkipBlockKind
    condition: str


class SizingPreview(BaseModel):
    """A read-only sizing headroom preview — never a quantity the user typed.
    Every liquidation figure is a labeled estimate (F3 honesty rules)."""

    available: bool
    quantity: float | None = None
    notional: float | None = None
    required_margin: float | None = None
    effective_leverage: float | None = None
    liquidation_price: float | None = None
    liquidation_model: str | None = None
    risk_percent: float
    max_risk_percent_at_leverage: float | None = None
    liq_buffer_ok: bool | None = None
    is_estimate: bool = True


class CheckResultItem(BaseModel):
    check: str
    passed: bool
    detail: str
    group: str


class DryRunPermitPreview(BaseModel):
    """The dry-run Trade Permit — the deterministic desk's verdict, run with
    no order intent and NOT persisted. Same checks as a real permit."""

    status: Literal["APPROVED", "REJECTED"]
    reasons: list[str]
    quality_score: float | None = None
    quality_disclaimer: str | None = None
    checks: list[CheckResultItem]


class SkipCheckAnswer(BaseModel):
    symbol: str
    objective: SkipObjective
    direction: SkipDirection
    answer: SkipAnswer
    viable: bool
    headline: str
    supportive_read: list[SkipBlock]
    cautions: list[SkipBlock]
    no_opinion: list[SkipBlock]
    what_flips_it: list[WhatFlipsItItem]
    permit_preview: DryRunPermitPreview
    sizing: SizingPreview
    catalyst_available: bool
    evaluated_at: datetime
    session: str


class SkipCheckEnvelope(BaseModel):
    data: SkipCheckAnswer
    meta: None = None
    error: None = None
