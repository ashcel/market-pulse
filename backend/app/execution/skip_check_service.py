"""Skip Check assembly — R2 (EDR 0022 decision 5).

Two layers, deliberately separated so the honesty-critical logic is pure and
fixture-testable:

- `build_skip_answer` — a **pure, deterministic** function: it takes the
  already-computed desk pieces (a `PermitDecision`, the quality score, the
  sizing result, behavior flags, the engine verdict, a catalyst window) and
  produces the typed `SkipCheckAnswer`. No DB, no network, no clock reads
  beyond the caller-supplied `now`. This is the classifier the contract tests
  exercise for the three answer shapes.
- `assemble_skip_check` — the async orchestrator: it reuses
  `permit_request_service`'s server-side account-state + sizing + risk-engine
  path (WITHOUT persisting a permit or placing anything), best-effort resolves
  a mark price, best-effort reads the catalyst window from the events plane
  (omitted if unreachable), then calls the pure classifier.

Nothing here is AI. The verdict context is engine-derived (deterministic) and
optional; when absent the objective-fit block is a first-class "no opinion".
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from .config import execution_settings
from .permit_request_schemas import PermitRequest
from .permit_request_service import (
    _compute_rr,
    _default_symbol_filters,
    _determine_session,
    _server_account_state,
    _side,
    _stop_distance_pct,
)
from .quality_score import (
    StopPlacementQuality,
    TradeQualityInput,
    TradeQualityScore,
    score_trade_quality,
)
from .risk_engine import (
    AccountState,
    PermitCheck,
    PermitDecision,
    PermitStatus,
    TradeProposal,
    evaluate_permit,
)
from .schemas import PERMIT_CHECK_GROUPS
from .service import get_current_constitution
from .sizing import SizingResult, size_position
from .skip_check_schemas import (
    BlockStatus,
    CheckResultItem,
    DryRunPermitPreview,
    EvidenceItem,
    SizingPreview,
    SkipAnswer,
    SkipBlock,
    SkipBlockKind,
    SkipCheckAnswer,
    SkipCheckRequest,
    SkipCode,
    SkipDirection,
    SkipObjective,
    VerdictContextInput,
    VerdictState,
    WhatFlipsItItem,
)

# Objective → catalyst-window horizon (hours). A scalp cares about the next few
# hours; a swing about the next week.
_WINDOW_HOURS: dict[SkipObjective, int] = {
    SkipObjective.SCALP: 12,
    SkipObjective.INTRADAY: 48,
    SkipObjective.SWING: 168,
    SkipObjective.POSITION: 720,
}


@dataclass(frozen=True)
class CatalystInfo:
    """A single most-salient upcoming event in the objective's window, already
    scored by the deterministic Catalyst Impact Score. `None` in the answer
    assembly means the events plane was unreachable — the block is omitted."""

    title: str
    impact: str  # low | medium | high
    direction: str  # bullish | bearish | neutral
    hours_until: float


# ── check grouping (mirrors the permit-card sections, reused deterministically) ─

_CONSTITUTION_CHECKS = (
    PermitCheck.RISK_PCT_OUT_OF_BAND,
    PermitCheck.MAX_LEVERAGE,
    PermitCheck.SYMBOL_NOT_ALLOWED,
    PermitCheck.SESSION_NOT_ALLOWED,
)
_LOSS_CHECKS = (PermitCheck.DAILY_LOSS_LIMIT, PermitCheck.WEEKLY_LOSS_LIMIT)
_EXPOSURE_CHECKS = (
    PermitCheck.MAX_CONCURRENT_POSITIONS,
    PermitCheck.MAX_CORRELATED_EXPOSURE,
)


def _failed(decision: PermitDecision, checks: tuple[PermitCheck, ...]) -> list[PermitCheck]:
    failing = {r.check for r in decision.checks if not r.passed}
    return [c for c in checks if c in failing]


def _detail_for(decision: PermitDecision, check: PermitCheck) -> str:
    for r in decision.checks:
        if r.check is check:
            return r.detail
    return ""


def _max_risk_pct_at_leverage(
    entry: Decimal, stop_distance: Decimal, leverage: Decimal
) -> float | None:
    """§3.1 rule: leverage caps notional (`balance x leverage`), so the max
    achievable risk% at a given leverage+stop is `leverage x (stop_distance /
    entry) x 100`. Balance cancels out. Existing-margin drawdown is ignored
    here (the ticket computes the precise, margin-aware version); this is the
    headroom ceiling."""
    if entry <= 0 or stop_distance <= 0:
        return None
    return float(leverage * (stop_distance / entry) * Decimal("100"))


# ── the pure classifier ────────────────────────────────────────────────────


def build_skip_answer(
    *,
    symbol: str,
    objective: SkipObjective,
    direction: SkipDirection,
    decision: PermitDecision,
    quality: TradeQualityScore | None,
    account_stale: bool,
    behavior_flags: frozenset[str],
    binding_cooldowns: dict[str, bool],
    verdict: VerdictContextInput | None,
    catalyst: CatalystInfo | None,
    sizing: SizingResult | None,
    stop_provided: bool,
    target_provided: bool,
    price_available: bool,
    leverage: Decimal,
    risk_percent: Decimal,
    now: datetime,
) -> SkipCheckAnswer:
    """Assemble the typed answer from deterministic inputs. Pure."""
    supportive: list[SkipBlock] = []
    cautions: list[SkipBlock] = []
    no_opinion: list[SkipBlock] = []

    def add(block: SkipBlock) -> None:
        bucket = {
            BlockStatus.SUPPORTIVE: supportive,
            BlockStatus.CAUTION: cautions,
            BlockStatus.NO_OPINION: no_opinion,
        }[block.status]
        bucket.append(block)

    # 1. Constitution headroom (risk band, leverage, symbol/session).
    con_failed = _failed(decision, _CONSTITUTION_CHECKS)
    if con_failed:
        add(
            SkipBlock(
                kind=SkipBlockKind.CONSTITUTION_HEADROOM,
                status=BlockStatus.CAUTION,
                code=SkipCode.CONSTITUTION_LIMIT_HIT,
                headline="A constitution limit is hit",
                detail="; ".join(_detail_for(decision, c) for c in con_failed),
                blocking=True,
                evidence=[
                    EvidenceItem(label=c.value, value=_detail_for(decision, c)) for c in con_failed
                ],
            )
        )
    else:
        add(
            SkipBlock(
                kind=SkipBlockKind.CONSTITUTION_HEADROOM,
                status=BlockStatus.SUPPORTIVE,
                code=SkipCode.ALL_LIMITS_CLEAR,
                headline="Room on every constitution limit",
                detail="risk band, leverage, symbol and session all clear",
            )
        )

    # 2. Loss budget (daily / weekly).
    loss_failed = _failed(decision, _LOSS_CHECKS)
    if loss_failed:
        add(
            SkipBlock(
                kind=SkipBlockKind.LOSS_BUDGET,
                status=BlockStatus.CAUTION,
                code=SkipCode.LOSS_BUDGET_EXHAUSTED,
                headline="Loss budget exhausted",
                detail="; ".join(_detail_for(decision, c) for c in loss_failed),
                blocking=True,
                evidence=[
                    EvidenceItem(label=c.value, value=_detail_for(decision, c)) for c in loss_failed
                ],
            )
        )
    else:
        add(
            SkipBlock(
                kind=SkipBlockKind.LOSS_BUDGET,
                status=BlockStatus.SUPPORTIVE,
                code=SkipCode.LOSS_BUDGET_ROOM,
                headline="Daily and weekly loss budget intact",
                detail="realized-loss limits not reached",
            )
        )

    # 3. Portfolio exposure (concurrency, correlation).
    exp_failed = _failed(decision, _EXPOSURE_CHECKS)
    if exp_failed:
        add(
            SkipBlock(
                kind=SkipBlockKind.PORTFOLIO_EXPOSURE,
                status=BlockStatus.CAUTION,
                code=SkipCode.EXPOSURE_EXCEEDED,
                headline="Portfolio exposure limit reached",
                detail="; ".join(_detail_for(decision, c) for c in exp_failed),
                blocking=True,
                evidence=[
                    EvidenceItem(label=c.value, value=_detail_for(decision, c)) for c in exp_failed
                ],
            )
        )
    else:
        add(
            SkipBlock(
                kind=SkipBlockKind.PORTFOLIO_EXPOSURE,
                status=BlockStatus.SUPPORTIVE,
                code=SkipCode.EXPOSURE_ROOM,
                headline="Room within concurrency and correlation caps",
                detail="adding this position stays inside portfolio limits",
            )
        )

    # 4. Account state freshness (fail-closed).
    if account_stale:
        add(
            SkipBlock(
                kind=SkipBlockKind.ACCOUNT_STATE,
                status=BlockStatus.CAUTION,
                code=SkipCode.ACCOUNT_STALE,
                headline="Can't read live account state",
                detail="account snapshot is stale — the desk fails closed",
                blocking=True,
            )
        )
    else:
        add(
            SkipBlock(
                kind=SkipBlockKind.ACCOUNT_STATE,
                status=BlockStatus.SUPPORTIVE,
                code=SkipCode.ACCOUNT_FRESH,
                headline="Live account state is fresh",
                detail="balance, positions and loss budget read live",
            )
        )

    # 5. Risk / reward — needs both stop and target, else first-class no-opinion.
    if not price_available:
        no_opinion.append(
            SkipBlock(
                kind=SkipBlockKind.RISK_REWARD,
                status=BlockStatus.NO_OPINION,
                code=SkipCode.PRICE_UNAVAILABLE,
                headline="No opinion — no entry price",
                detail="supply an entry price so risk/reward can be judged",
            )
        )
    elif not stop_provided:
        no_opinion.append(
            SkipBlock(
                kind=SkipBlockKind.RISK_REWARD,
                status=BlockStatus.NO_OPINION,
                code=SkipCode.STOP_NOT_PROVIDED,
                headline="No opinion — no stop yet",
                detail="attach a planned stop and target to judge risk/reward",
            )
        )
    elif not target_provided:
        no_opinion.append(
            SkipBlock(
                kind=SkipBlockKind.RISK_REWARD,
                status=BlockStatus.NO_OPINION,
                code=SkipCode.TARGET_NOT_PROVIDED,
                headline="No opinion — no target yet",
                detail="attach a target so reward-to-risk can be judged",
            )
        )
    else:
        rr_failed = PermitCheck.RR_BELOW_MIN in {r.check for r in decision.checks if not r.passed}
        if rr_failed:
            cautions.append(
                SkipBlock(
                    kind=SkipBlockKind.RISK_REWARD,
                    status=BlockStatus.CAUTION,
                    code=SkipCode.RR_BELOW_MIN,
                    headline="Reward-to-risk below the minimum",
                    detail=_detail_for(decision, PermitCheck.RR_BELOW_MIN),
                    blocking=False,
                )
            )
        else:
            supportive.append(
                SkipBlock(
                    kind=SkipBlockKind.RISK_REWARD,
                    status=BlockStatus.SUPPORTIVE,
                    code=SkipCode.RR_MEETS_MIN,
                    headline="Reward-to-risk clears the minimum",
                    detail=_detail_for(decision, PermitCheck.RR_BELOW_MIN),
                )
            )

    # 6. Liquidation buffer (only meaningful with leverage>1, a stop, and a
    #    liquidation estimate).
    if leverage <= 1 or sizing is None or sizing.liquidation_price is None or not stop_provided:
        no_opinion.append(
            SkipBlock(
                kind=SkipBlockKind.LIQUIDATION_BUFFER,
                status=BlockStatus.NO_OPINION,
                code=SkipCode.LIQ_NOT_APPLICABLE,
                headline="No opinion — liquidation buffer not applicable",
                detail="leverage 1x, no stop, or unsized — no liquidation to compare",
            )
        )
    else:
        liq_failed = PermitCheck.LIQUIDATION_INSIDE_STOP in {
            r.check for r in decision.checks if not r.passed
        }
        if liq_failed:
            cautions.append(
                SkipBlock(
                    kind=SkipBlockKind.LIQUIDATION_BUFFER,
                    status=BlockStatus.CAUTION,
                    code=SkipCode.LIQ_INSIDE_STOP,
                    headline="Liquidation sits inside your stop",
                    detail=_detail_for(decision, PermitCheck.LIQUIDATION_INSIDE_STOP),
                    blocking=False,
                )
            )
        else:
            supportive.append(
                SkipBlock(
                    kind=SkipBlockKind.LIQUIDATION_BUFFER,
                    status=BlockStatus.SUPPORTIVE,
                    code=SkipCode.LIQ_BEYOND_STOP,
                    headline="Liquidation sits safely beyond your stop",
                    detail=_detail_for(decision, PermitCheck.LIQUIDATION_INSIDE_STOP),
                )
            )

    # 7. Behavior flags (advisory vs binding cooldown).
    if behavior_flags:
        binding = sorted(f for f in behavior_flags if binding_cooldowns.get(f) is True)
        advisory = sorted(f for f in behavior_flags if binding_cooldowns.get(f) is not True)
        if binding:
            cautions.append(
                SkipBlock(
                    kind=SkipBlockKind.BEHAVIOR,
                    status=BlockStatus.CAUTION,
                    code=SkipCode.BEHAVIOR_BINDING,
                    headline="A binding behavior cooldown is active",
                    detail=f"binding: {', '.join(binding)}",
                    blocking=True,
                    evidence=[EvidenceItem(label=f, value="binding cooldown") for f in binding],
                )
            )
        if advisory:
            cautions.append(
                SkipBlock(
                    kind=SkipBlockKind.BEHAVIOR,
                    status=BlockStatus.CAUTION,
                    code=SkipCode.BEHAVIOR_ADVISORY,
                    headline="Behavior pattern flagged",
                    detail=f"advisory: {', '.join(advisory)}",
                    blocking=False,
                    evidence=[EvidenceItem(label=f, value="advisory flag") for f in advisory],
                )
            )
    else:
        supportive.append(
            SkipBlock(
                kind=SkipBlockKind.BEHAVIOR,
                status=BlockStatus.SUPPORTIVE,
                code=SkipCode.NO_BEHAVIOR_FLAGS,
                headline="No behavior flags",
                detail="no revenge, overtrading or tilt pattern detected",
            )
        )

    # 8. Objective / regime fit (engine verdict — optional, else no-opinion).
    if verdict is None:
        no_opinion.append(
            SkipBlock(
                kind=SkipBlockKind.OBJECTIVE_FIT,
                status=BlockStatus.NO_OPINION,
                code=SkipCode.NO_VERDICT_SUPPLIED,
                headline="No opinion — no engine verdict",
                detail="the engine's per-objective verdict was not supplied",
            )
        )
    elif verdict.state is VerdictState.LIVE:
        supportive.append(
            SkipBlock(
                kind=SkipBlockKind.OBJECTIVE_FIT,
                status=BlockStatus.SUPPORTIVE,
                code=SkipCode.VERDICT_LIVE,
                headline=f"{objective.value.title()} verdict is live",
                detail="the engine's setup for this objective is valid now",
            )
        )
    elif verdict.state is VerdictState.NOT_YET:
        cautions.append(
            SkipBlock(
                kind=SkipBlockKind.OBJECTIVE_FIT,
                status=BlockStatus.CAUTION,
                code=SkipCode.VERDICT_NOT_YET,
                headline=f"{objective.value.title()} setup not yet valid",
                detail=verdict.flip_condition
                or "the engine's trigger for this objective has not fired",
                blocking=False,
            )
        )
    elif verdict.state is VerdictState.WRONG_STRATEGY:
        cautions.append(
            SkipBlock(
                kind=SkipBlockKind.OBJECTIVE_FIT,
                status=BlockStatus.CAUTION,
                code=SkipCode.VERDICT_WRONG_STRATEGY,
                headline=f"Wrong strategy for a {objective.value}",
                detail=verdict.flip_condition
                or "this objective is a poor fit for current structure",
                blocking=False,
            )
        )
    else:  # UNKNOWN
        no_opinion.append(
            SkipBlock(
                kind=SkipBlockKind.OBJECTIVE_FIT,
                status=BlockStatus.NO_OPINION,
                code=SkipCode.INSUFFICIENT_EVIDENCE,
                headline="No opinion — engine verdict indeterminate",
                detail="the engine could not resolve a verdict for this objective",
            )
        )

    # Regime alignment (only when the verdict carried it).
    if verdict is not None and verdict.regime_aligned is not None:
        if verdict.regime_aligned:
            supportive.append(
                SkipBlock(
                    kind=SkipBlockKind.REGIME_FIT,
                    status=BlockStatus.SUPPORTIVE,
                    code=SkipCode.REGIME_ALIGNED,
                    headline="Direction aligns with the regime",
                    detail=f"regime: {verdict.regime or 'aligned'}",
                )
            )
        else:
            cautions.append(
                SkipBlock(
                    kind=SkipBlockKind.REGIME_FIT,
                    status=BlockStatus.CAUTION,
                    code=SkipCode.REGIME_MISALIGNED,
                    headline="Direction fights the regime",
                    detail=f"regime: {verdict.regime or 'misaligned'}",
                    blocking=False,
                )
            )

    # 9. Catalyst window (omitted entirely when the events plane is unreachable).
    if catalyst is not None:
        adverse = (direction is SkipDirection.LONG and catalyst.direction == "bearish") or (
            direction is SkipDirection.SHORT and catalyst.direction == "bullish"
        )
        salient = catalyst.impact in ("medium", "high")
        if salient and (adverse or catalyst.direction == "neutral"):
            cautions.append(
                SkipBlock(
                    kind=SkipBlockKind.CATALYST_WINDOW,
                    status=BlockStatus.CAUTION,
                    code=SkipCode.ADVERSE_CATALYST,
                    headline=(
                        f"{catalyst.impact.title()}-impact event in {catalyst.hours_until:.0f}h"
                    ),
                    detail=f"{catalyst.title} ({catalyst.direction}) inside your window",
                    blocking=False,
                    evidence=[
                        EvidenceItem(label="impact", value=catalyst.impact),
                        EvidenceItem(label="direction", value=catalyst.direction),
                        EvidenceItem(label="hours_until", value=f"{catalyst.hours_until:.1f}"),
                    ],
                )
            )
        else:
            supportive.append(
                SkipBlock(
                    kind=SkipBlockKind.CATALYST_WINDOW,
                    status=BlockStatus.SUPPORTIVE,
                    code=SkipCode.NO_ADVERSE_CATALYST,
                    headline="No adverse catalyst in the window",
                    detail=f"nearest event: {catalyst.title} ({catalyst.impact} impact)",
                )
            )

    # ── overall answer + viability ─────────────────────────────────────────
    has_blocking = any(b.blocking for b in cautions)
    viable = price_available and not account_stale and not has_blocking

    if cautions:
        answer = SkipAnswer.CAUTION
    elif (
        verdict is not None
        and verdict.state is VerdictState.LIVE
        and verdict.regime_aligned is not False
    ):
        answer = SkipAnswer.SUPPORTIVE
    else:
        answer = SkipAnswer.NO_OPINION

    headline = _overall_headline(answer, viable)

    what_flips_it = _what_flips_it(cautions + no_opinion, verdict)

    permit_preview = _permit_preview(decision, quality)
    sizing_preview = _sizing_preview(sizing, risk_percent, decision)

    return SkipCheckAnswer(
        symbol=symbol,
        objective=objective,
        direction=direction,
        answer=answer,
        viable=viable,
        headline=headline,
        supportive_read=supportive,
        cautions=cautions,
        no_opinion=no_opinion,
        what_flips_it=what_flips_it,
        permit_preview=permit_preview,
        sizing=sizing_preview,
        catalyst_available=catalyst is not None,
        evaluated_at=now,
        session=decision.session,
    )


def _overall_headline(answer: SkipAnswer, viable: bool) -> str:
    if answer is SkipAnswer.CAUTION:
        return (
            "Cautions stated — sit out unless they clear"
            if not viable
            else "Cautions stated — trade only with eyes open"
        )
    if answer is SkipAnswer.SUPPORTIVE:
        return "Supportive read — the desk and the engine agree"
    return "No opinion — insufficient evidence to call it"


def _what_flips_it(
    blocks: list[SkipBlock],
    verdict: VerdictContextInput | None,
) -> list[WhatFlipsItItem]:
    """Always non-empty. One typed flip condition per non-supportive block,
    plus a deterministic fallback so 'what flips it' is present even on a
    clean supportive read."""
    items: list[WhatFlipsItItem] = []
    seen: set[SkipBlockKind] = set()
    for b in blocks:
        if b.kind in seen:
            continue
        seen.add(b.kind)
        items.append(WhatFlipsItItem(kind=b.kind, condition=_flip_condition(b, verdict)))
    if not items:
        # Clean supportive read: state what would flip it TO a skip.
        items.append(
            WhatFlipsItItem(
                kind=SkipBlockKind.CATALYST_WINDOW,
                condition="a new high-impact catalyst, a constitution-limit breach, "
                "or the engine verdict dropping below live flips this to a skip",
            )
        )
    return items


def _flip_condition(block: SkipBlock, verdict: VerdictContextInput | None) -> str:
    match block.code:
        case SkipCode.CONSTITUTION_LIMIT_HIT:
            return "lower risk% or leverage into the constitution band, or wait for the reset"
        case SkipCode.LOSS_BUDGET_EXHAUSTED:
            return "the loss budget resets on the next day/week boundary"
        case SkipCode.EXPOSURE_EXCEEDED:
            return "close correlated exposure or free a position slot"
        case SkipCode.ACCOUNT_STALE:
            return "live account state must refresh before the desk can judge this"
        case SkipCode.RR_BELOW_MIN:
            return "raise the target or tighten the stop until reward-to-risk clears the minimum"
        case SkipCode.LIQ_INSIDE_STOP:
            return "reduce leverage until liquidation sits beyond your stop by the required buffer"
        case SkipCode.BEHAVIOR_BINDING | SkipCode.BEHAVIOR_ADVISORY:
            return "the flag clears once the cooldown window passes without escalation"
        case SkipCode.VERDICT_NOT_YET:
            return (
                verdict.flip_condition
                if verdict and verdict.flip_condition
                else "the engine's trigger for this objective must fire"
            )
        case SkipCode.VERDICT_WRONG_STRATEGY:
            return "pick an objective that fits current structure, or wait for it to change"
        case SkipCode.REGIME_MISALIGNED:
            return "the regime must turn to favor your direction"
        case SkipCode.ADVERSE_CATALYST:
            return "the flagged event must pass, then re-check once volatility settles"
        case SkipCode.STOP_NOT_PROVIDED:
            return "attach a planned stop"
        case SkipCode.TARGET_NOT_PROVIDED:
            return "attach a target"
        case SkipCode.PRICE_UNAVAILABLE:
            return "supply an entry price"
        case SkipCode.NO_VERDICT_SUPPLIED:
            return "the engine's per-objective verdict must resolve to a read"
        case _:
            return "more evidence is needed before this block has an opinion"


def _permit_preview(
    decision: PermitDecision, quality: TradeQualityScore | None
) -> DryRunPermitPreview:
    checks = [
        CheckResultItem(
            check=r.check.value,
            passed=r.passed,
            detail=r.detail,
            group=PERMIT_CHECK_GROUPS[r.check],
        )
        for r in decision.checks
    ]
    reasons = [c.detail for c in decision.checks if not c.passed]
    status = "APPROVED" if decision.status is PermitStatus.APPROVED else "REJECTED"
    return DryRunPermitPreview(
        status=status,
        reasons=reasons,
        quality_score=quality.total if quality is not None else None,
        quality_disclaimer=quality.disclaimer if quality is not None else None,
        checks=checks,
    )


def _sizing_preview(
    sizing: SizingResult | None, risk_percent: Decimal, decision: PermitDecision
) -> SizingPreview:
    if sizing is None or not sizing.approved:
        return SizingPreview(available=False, risk_percent=float(risk_percent))
    max_risk = _max_risk_pct_at_leverage(
        sizing.entry_price, sizing.stop_distance, sizing.effective_leverage
    )
    liq_ok: bool | None = None
    for r in decision.checks:
        if r.check is PermitCheck.LIQUIDATION_INSIDE_STOP:
            liq_ok = r.passed
            break
    return SizingPreview(
        available=True,
        quantity=float(sizing.quantity),
        notional=float(sizing.notional),
        required_margin=float(sizing.required_margin),
        effective_leverage=float(sizing.effective_leverage),
        liquidation_price=float(sizing.liquidation_price)
        if sizing.liquidation_price is not None
        else None,
        liquidation_model=sizing.liquidation_model,
        risk_percent=float(risk_percent),
        max_risk_percent_at_leverage=max_risk,
        liq_buffer_ok=liq_ok,
    )


# ── async orchestration ────────────────────────────────────────────────────


async def _catalyst_window(
    db: AsyncSession, symbol: str, objective: SkipObjective
) -> CatalystInfo | None:
    """Best-effort read of the most salient upcoming event in the window.

    Reads the events plane (catalysts + market catalysts + econ calendar).
    Returns None on any failure — the block is then omitted (spec: "events
    plane if reachable, else omit")."""
    try:
        from app.events.service import (
            list_economic_events,
            list_market_catalysts,
            list_upcoming_catalysts,
        )

        now = datetime.now(UTC)
        until = now + timedelta(hours=_WINDOW_HOURS[objective])
        rows = []
        rows += await list_upcoming_catalysts(db, symbol, until, limit=10)
        rows += await list_market_catalysts(db, until, limit=10)
        rows += await list_economic_events(db, until, min_impact="medium", limit=20)
        if not rows:
            return CatalystInfo(
                title="none scheduled", impact="low", direction="neutral", hours_until=0.0
            )
        top = max(rows, key=lambda r: r.impact_score)
        occurs_at = top.occurs_at
        if occurs_at.tzinfo is None:
            occurs_at = occurs_at.replace(tzinfo=UTC)
        hours_until = (occurs_at - now).total_seconds() / 3600.0
        return CatalystInfo(
            title=top.title,
            impact=top.impact,
            direction=top.direction,
            hours_until=hours_until,
        )
    except Exception:
        return None


async def assemble_skip_check(
    db: AsyncSession,
    user_id: str,
    request: SkipCheckRequest,
) -> SkipCheckAnswer:
    """Assemble the deterministic Skip Check answer. Persists nothing, places
    nothing — a dry-run of the exact desk a real permit runs."""
    constitution = await get_current_constitution(db, user_id)

    session = _determine_session()
    now = datetime.now(tz=UTC).replace(tzinfo=None)

    risk_percent = (
        request.risk_percent
        if request.risk_percent is not None
        else Decimal(str(constitution.risk_per_trade_percent))
    )
    leverage = request.leverage if request.leverage is not None else Decimal("1")

    # Build a ticket the shared account-state helper understands (for behavior
    # flags keyed to the symbol).
    ticket_for_state = PermitRequest(
        symbol=request.symbol,
        side=request.direction.value,
        entry_price=request.entry_price or Decimal("1"),
        stop_price=request.planned_stop or Decimal("1"),
        risk_percent=risk_percent,
        leverage=leverage,
        margin_type=request.margin_type,
        correlation_bucket=request.correlation_bucket,
    )
    account_state, _ = await _server_account_state(db, user_id, ticket_for_state, now)

    # Resolve an entry price: caller-supplied wins; else best-effort mark price.
    entry_price = request.entry_price
    if entry_price is None:
        entry_price = await _resolve_mark_price(db, user_id, request.symbol)
    price_available = entry_price is not None and entry_price > 0

    side = _side(request.direction.value)
    stop_provided = request.planned_stop is not None
    target_provided = request.take_profit is not None

    sizing: SizingResult | None = None
    proposed_notional_percent = Decimal("0")
    can_size = (
        price_available
        and stop_provided
        and not account_state.is_stale
        and account_state.balance > 0
    )
    if can_size:
        base = _default_symbol_filters()
        from .sizing import SymbolFilters

        filters = SymbolFilters(
            symbol=request.symbol.upper(),
            step_size=base.step_size,
            min_qty=base.min_qty,
            min_notional=base.min_notional,
            tick_size=base.tick_size,
        )
        try:
            sizing = size_position(
                symbol=request.symbol.upper(),
                side=side,
                balance=account_state.balance,
                entry_price=entry_price,
                stop_price=request.planned_stop,
                risk_fraction=risk_percent / Decimal("100"),
                filters=filters,
                leverage=leverage,
                margin_type=request.margin_type,
            )
            if sizing.approved:
                proposed_notional_percent = sizing.notional / account_state.balance * Decimal("100")
        except ValueError:
            sizing = None

    proposal = TradeProposal(
        symbol=request.symbol.upper(),
        side=side,
        entry_price=entry_price if price_available else Decimal("0"),
        stop_price=request.planned_stop,
        take_profit_price=request.take_profit,
        risk_percent=risk_percent,
        leverage=leverage,
        correlation_bucket=request.correlation_bucket,
        proposed_notional_percent=proposed_notional_percent,
        liquidation_price=sizing.liquidation_price if sizing is not None else None,
        margin_type=request.margin_type,
    )

    decision = evaluate_permit(
        proposal=proposal,
        account_state=account_state,
        constitution=constitution,
        now=now,
        session=session,
    )

    quality: TradeQualityScore | None = None
    if price_available:
        rr = _compute_rr(proposal.entry_price, request.planned_stop, request.take_profit, side)
        quality = score_trade_quality(
            TradeQualityInput(
                risk_reward_ratio=rr,
                min_risk_reward=constitution.min_risk_reward,
                stop_placement=StopPlacementQuality.NONE,
                daily_risk_used_percent=float(-account_state.daily_realized_pnl_percent)
                if account_state.daily_realized_pnl_percent < 0
                else 0.0,
                daily_loss_limit_percent=constitution.daily_loss_limit_percent,
                weekly_risk_used_percent=float(-account_state.weekly_realized_pnl_percent)
                if account_state.weekly_realized_pnl_percent < 0
                else 0.0,
                weekly_loss_limit_percent=constitution.weekly_loss_limit_percent,
                concurrent_positions_open=account_state.open_position_count,
                max_concurrent_positions=constitution.max_concurrent_positions,
                correlated_exposure_percent=float(
                    account_state.exposure_by_bucket_percent.get(
                        request.correlation_bucket, Decimal("0")
                    )
                ),
                max_correlated_exposure_percent=constitution.max_correlated_exposure_percent,
                stop_distance_percent=_stop_distance_pct(proposal.entry_price, request.planned_stop)
                if stop_provided
                else 0.0,
                atr_percent=0.0,
                session=session,
                allowed_sessions=tuple(constitution.allowed_sessions),
                is_high_liquidity_window=True,
                behavior_flags=tuple(account_state.active_behavior_flags),
            )
        )

    catalyst = await _catalyst_window(db, request.symbol.upper(), request.objective)

    return build_skip_answer(
        symbol=request.symbol.upper(),
        objective=request.objective,
        direction=request.direction,
        decision=decision,
        quality=quality,
        account_stale=account_state.is_stale,
        behavior_flags=account_state.active_behavior_flags,
        binding_cooldowns=dict(constitution.binding_cooldowns),
        verdict=request.verdict,
        catalyst=catalyst,
        sizing=sizing,
        stop_provided=stop_provided,
        target_provided=target_provided,
        price_available=price_available,
        leverage=leverage,
        risk_percent=risk_percent,
        now=now,
    )


async def _resolve_mark_price(db: AsyncSession, user_id: str, symbol: str) -> Decimal | None:
    """Best-effort mark-price fetch for skip check when the caller didn't supply
    an entry. Uses the user's execution key if present; returns None on any
    failure (the answer then degrades to a first-class 'no opinion')."""
    try:
        from .binance_client import BinanceExecClient
        from .exec_key_crypto import decrypt
        from .exec_key_service import get_exec_key

        key = await get_exec_key(db, user_id)
        secret = decrypt(key.encrypted_secret)
        client = BinanceExecClient(key.api_key, secret, testnet=key.testnet)
        data = await client.get_mark_price(symbol.upper())
        price = data.get("markPrice") if isinstance(data, dict) else None
        return Decimal(str(price)) if price is not None else None
    except Exception:
        return None


# execution_settings is imported for parity with permit_request_service's
# server-side account fetch (used indirectly via _server_account_state).
_ = execution_settings
