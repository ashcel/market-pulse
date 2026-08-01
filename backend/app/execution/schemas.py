from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .quality_score import SCORE_DISCLAIMER, TradeQualityScore
from .risk_engine import PermitCheck, PermitDecision, PermitStatus


class ConstitutionCreate(BaseModel):
    """Request body for creating a new constitution version.

    Deliberately loose on numeric bounds (`Field(gt=...)` etc. would raise a
    generic 422 before `validate_constitution` ever runs) — band enforcement
    lives entirely in `validation.py` so it stays pure and independently
    unit-testable, and so the API returns enumerated per-field reasons
    instead of pydantic's generic error shape.
    """

    risk_per_trade_percent: float
    daily_loss_limit_percent: float
    weekly_loss_limit_percent: float
    max_leverage: int
    max_concurrent_positions: int
    max_correlated_exposure_percent: float
    min_risk_reward: float
    allowed_sessions: list[str] = Field(default_factory=list)
    allowed_symbols: list[str] = Field(default_factory=list)
    binding_cooldowns: dict[str, bool] = Field(default_factory=dict)


class ConstitutionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    version: int
    risk_per_trade_percent: float
    daily_loss_limit_percent: float
    weekly_loss_limit_percent: float
    max_leverage: int
    max_concurrent_positions: int
    max_correlated_exposure_percent: float
    min_risk_reward: float
    allowed_sessions: list[str]
    allowed_symbols: list[str]
    binding_cooldowns: dict[str, bool]
    created_at: datetime


class ConstitutionDetailEnvelope(BaseModel):
    data: ConstitutionResponse
    # The constitution endpoint is the Book's single execution-policy read.
    # This is operator state, not a user-editable constitution field.
    meta: dict[str, bool] | None = None
    error: None = None


class ConstitutionListEnvelope(BaseModel):
    data: list[ConstitutionResponse]
    meta: dict[str, Any]
    error: None = None


class ConstitutionAuditResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    constitution_id: str
    version: int
    action: str
    changed_by_user_id: str
    before_snapshot: dict[str, Any] | None = None
    after_snapshot: dict[str, Any]
    created_at: datetime


class ConstitutionAuditListEnvelope(BaseModel):
    data: list[ConstitutionAuditResponse]
    meta: dict[str, Any]
    error: None = None


# ---------------------------------------------------------------------------
# Permit-card response schema — M9-T5 (EDR 0020 decision 6).
#
# Fixed to exactly the EDR's two shapes:
#   - APPROVED: Quality / Constitution / Portfolio Risk / Daily Budget / Decision
#   - REJECTED: Decision + Reasons[]
#
# `PermitCheck` members are grouped into the three named board sections a
# card shows. This grouping is a display concern (not something
# `risk_engine.py` — which stays UI-agnostic — knows about), so it lives
# here rather than on `PermitCheck` itself:
#   - Constitution: the rule-band checks a trader configures directly
#     (risk %, leverage, R:R, mandatory stop, symbol/session allow-lists,
#     binding behavior cooldowns).
#   - Portfolio Risk: checks that depend on the *account snapshot* the
#     permit was judged against (open-position count, correlated exposure,
#     staleness of that very snapshot).
#   - Daily Budget: the daily/weekly realized-loss budget checks.
# ---------------------------------------------------------------------------

PERMIT_CHECK_GROUPS: dict[PermitCheck, str] = {
    PermitCheck.RISK_PCT_OUT_OF_BAND: "constitution",
    PermitCheck.MAX_LEVERAGE: "constitution",
    PermitCheck.RR_BELOW_MIN: "constitution",
    PermitCheck.STOP_MISSING: "constitution",
    PermitCheck.LIQUIDATION_INSIDE_STOP: "constitution",
    PermitCheck.SYMBOL_NOT_ALLOWED: "constitution",
    PermitCheck.SESSION_NOT_ALLOWED: "constitution",
    PermitCheck.BINDING_COOLDOWN_ACTIVE: "constitution",
    PermitCheck.MAX_CONCURRENT_POSITIONS: "portfolio_risk",
    PermitCheck.MAX_CORRELATED_EXPOSURE: "portfolio_risk",
    PermitCheck.STALE_ACCOUNT_STATE: "portfolio_risk",
    PermitCheck.DAILY_LOSS_LIMIT: "daily_budget",
    PermitCheck.WEEKLY_LOSS_LIMIT: "daily_budget",
}
assert set(PERMIT_CHECK_GROUPS) == set(PermitCheck), (
    "every PermitCheck must be assigned to exactly one permit-card section"
)


class CheckCardItem(BaseModel):
    """One `PermitCheckResult`, as rendered on a permit-card section."""

    check: str
    passed: bool
    detail: str


class ComponentCardItem(BaseModel):
    """One Trade Quality Score `ComponentScore`, as rendered on the card."""

    component: str
    weight: float
    fraction: float
    points: float
    detail: str


class QualityCardSection(BaseModel):
    """The 'Quality' section — never framed as a win-probability (EDR 0020
    decision 5 / M0 score-honesty rules). `label` is `SCORE_DISCLAIMER`
    verbatim so every render site carries the same evaluation-not-prediction
    wording without re-typing it."""

    score: float
    label: str = SCORE_DISCLAIMER
    components: list[ComponentCardItem]


class ConstitutionCardSection(BaseModel):
    checks: list[CheckCardItem]


class PortfolioRiskCardSection(BaseModel):
    checks: list[CheckCardItem]


class DailyBudgetCardSection(BaseModel):
    checks: list[CheckCardItem]


class DecisionCardSection(BaseModel):
    status: Literal["APPROVED", "REJECTED"]
    evaluated_at: datetime
    expires_at: datetime
    session: str


class LiquidationEstimate(BaseModel):
    """The F3 liquidation figure, carried with its honesty label so no render
    site can present it as an exact exchange price. `model` is the sizing
    module's `liquidation_model`: ``"isolated"`` or
    ``"isolated_conservative_for_cross"``. `price` is None at leverage 1 (no
    liquidation). `is_estimate` is always True — flat MMR, no funding/fees/
    tiered brackets (M0 score-honesty rules)."""

    price: float | None
    model: str
    margin_type: str
    is_estimate: bool = True


class PermitCardApproved(BaseModel):
    """The approved shape: Quality / Constitution / Portfolio Risk /
    Daily Budget / Decision."""

    permit_id: str
    quality: QualityCardSection
    constitution: ConstitutionCardSection
    portfolio_risk: PortfolioRiskCardSection
    daily_budget: DailyBudgetCardSection
    decision: DecisionCardSection
    # Margin mode the exchange will be set to before entry (F1) and the
    # labeled liquidation estimate (F3). Optional so the pure-decision tests
    # that build a card without sizing context keep passing.
    margin_type: str | None = None
    liquidation: LiquidationEstimate | None = None


class PermitCardRejected(BaseModel):
    """The rejected shape: Decision + Reasons[] only — deliberately no
    quality/board breakdown, matching the EDR's fixed shape."""

    permit_id: str
    decision: DecisionCardSection
    reasons: list[str]
    dependency_errors: list[str] = Field(default_factory=list)


def _check_items(decision: PermitDecision, group: str) -> list[CheckCardItem]:
    return [
        CheckCardItem(check=result.check.value, passed=result.passed, detail=result.detail)
        for result in decision.checks
        if PERMIT_CHECK_GROUPS[result.check] == group
    ]


def build_permit_card(
    permit_id: str,
    decision: PermitDecision,
    quality: TradeQualityScore,
    expires_at: datetime,
    *,
    margin_type: str | None = None,
    liquidation: LiquidationEstimate | None = None,
    dependency_errors: list[str] | None = None,
) -> PermitCardApproved | PermitCardRejected:
    """Build the fixed permit-card shape from a `PermitDecision` +
    `TradeQualityScore`. Every field is copied straight from those
    deterministic inputs — this function does no scoring/judging of its
    own, it only reshapes for display (EDR 0020 decision 6: the card must
    never let anything but the persisted decision speak for the outcome).

    Returns the approved shape iff `decision.status is PermitStatus.APPROVED`;
    otherwise the rejected shape (Decision + Reasons[] only — `quality` is
    intentionally not surfaced there, per the EDR's fixed rejected shape).
    """
    decision_section = DecisionCardSection(
        status=decision.status.value,
        evaluated_at=decision.evaluated_at,
        expires_at=expires_at,
        session=decision.session,
    )

    if decision.status is PermitStatus.REJECTED:
        return PermitCardRejected(
            permit_id=permit_id,
            decision=decision_section,
            reasons=[c.detail for c in decision.checks if not c.passed],
            dependency_errors=dependency_errors or [],
        )

    return PermitCardApproved(
        permit_id=permit_id,
        quality=QualityCardSection(
            score=quality.total,
            label=quality.disclaimer,
            components=[
                ComponentCardItem(
                    component=c.component.value,
                    weight=c.weight,
                    fraction=c.fraction,
                    points=c.points,
                    detail=c.detail,
                )
                for c in quality.components
            ],
        ),
        constitution=ConstitutionCardSection(checks=_check_items(decision, "constitution")),
        portfolio_risk=PortfolioRiskCardSection(checks=_check_items(decision, "portfolio_risk")),
        daily_budget=DailyBudgetCardSection(checks=_check_items(decision, "daily_budget")),
        decision=decision_section,
        margin_type=margin_type,
        liquidation=liquidation,
    )
