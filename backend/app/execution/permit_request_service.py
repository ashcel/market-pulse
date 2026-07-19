"""Permit-request orchestration — M9 (EDR 0020 decision 6).

Wires together: constitution lookup → account state → sizing → risk-engine
→ quality score → persist permit → return permit card.

Account state is fetched server-side only. Clients never supply balances,
positions, PnL, exposure, or freshness flags.

The quality score inputs that require live chart data (ATR %, stop-placement
vs structure) are caller-supplied rather than fetched here so this service
stays I/O-free beyond the DB and the Binance account service.
"""

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from .account_service import get_account_state
from .behavior_detectors import evaluate_behavior_flags
from .behavior_service import get_trade_records_for_behavior
from .config import execution_settings
from .models import TradingConstitution
from .permit_request_schemas import PermitRequest
from .permit_service import create_permit
from .quality_score import (
    StopPlacementQuality,
    TradeQualityInput,
    score_trade_quality,
)
from .risk_engine import (
    AccountState,
    PermitDecision,
    TradeProposal,
    evaluate_permit,
)
from .schemas import PermitCardApproved, PermitCardRejected, build_permit_card
from .service import get_current_constitution
from .sizing import Side, SymbolFilters, size_position


def _default_symbol_filters() -> SymbolFilters:
    """Fallback filters when exchangeInfo isn't fetched yet (Phase A/B).

    A live exchangeInfo fetch is a Phase B improvement; for now, liberal
    defaults (0.001 step, 0.01 tick) let the sizing module produce a
    reasonable quantity and the risk engine judge the proposal.
    """
    return SymbolFilters(
        symbol="DEFAULT",
        step_size=Decimal("0.001"),
        min_qty=Decimal("0.001"),
        min_notional=Decimal("5.0"),
        tick_size=Decimal("0.01"),
    )


def _side(raw: str) -> Side:
    return Side.LONG if raw.upper() == "LONG" else Side.SHORT


def _determine_session() -> str:
    """Map current UTC hour to the session name used by the constitution.

    Sessions: asia (00-07 UTC), london (07-15 UTC), new_york (13-21 UTC),
    with overlaps scored to the most liquid active session.
    """
    hour = datetime.now(tz=UTC).hour
    if 13 <= hour < 21:
        return "new_york"
    if 7 <= hour < 15:
        return "london"
    return "asia"


def _compute_rr(
    entry: Decimal,
    stop: Decimal,
    target: Decimal | None,
    side: Side,
) -> float:
    if target is None or stop is None:
        return 0.0
    if side is Side.LONG:
        risk = entry - stop
        reward = target - entry
    else:
        risk = stop - entry
        reward = entry - target
    if risk <= 0 or reward <= 0:
        return 0.0
    return float(reward / risk)


def _stop_distance_pct(entry: Decimal, stop: Decimal) -> float:
    if entry <= 0:
        return 0.0
    return float(abs(entry - stop) / entry * 100)


def _unavailable_account_state() -> AccountState:
    """Fail-closed account snapshot for an unavailable fresh state.

    The values are never used to approve a permit: `is_stale=True` deterministically
    fails `STALE_ACCOUNT_STATE`, and sizing is skipped for stale account states.
    """
    return AccountState(
        balance=Decimal("0"),
        open_position_count=0,
        daily_realized_pnl_percent=Decimal("0"),
        weekly_realized_pnl_percent=Decimal("0"),
        exposure_by_bucket_percent={},
        active_behavior_flags=frozenset(),
        is_stale=True,
    )


async def _server_account_state(
    db: AsyncSession,
    user_id: str,
    ticket: PermitRequest,
    now: datetime,
) -> AccountState:
    try:
        account_state = await get_account_state(db, user_id, execution_settings)
    except Exception:
        return _unavailable_account_state()

    try:
        trade_records = await get_trade_records_for_behavior(db, user_id)
        behavior_flags = evaluate_behavior_flags(trade_records, ticket.symbol.upper(), now)
    except Exception:
        return replace(account_state, is_stale=True)

    return replace(account_state, active_behavior_flags=behavior_flags)


async def request_permit(
    db: AsyncSession,
    user_id: str,
    ticket: PermitRequest,
) -> tuple[PermitCardApproved | PermitCardRejected, str]:
    """Issue a Trade Permit for the given ticket.

    Returns ``(permit_card, permit_id)``.

    Account state is fetched server-side only. If fresh state cannot be
    obtained, the permit is persisted as a deterministic rejection with
    `STALE_ACCOUNT_STATE`.

    The permit is always persisted — approved and rejected alike (EDR 0020
    decision 6: 'Rejected permits are persisted too').
    """
    # 1. Constitution
    constitution: TradingConstitution = await get_current_constitution(db, user_id)

    # 2. Session (deterministic from wall clock — acceptable because the permit
    #    row captures this as a snapshot; it's not a pure input like now/session
    #    are in the risk engine itself).
    session = _determine_session()
    now = datetime.now(tz=UTC).replace(tzinfo=None)  # naive UTC for compat
    account_state = await _server_account_state(db, user_id, ticket, now)

    # 3. Sizing — derive proposed_notional_percent for the risk engine
    side = _side(ticket.side)
    filters = _default_symbol_filters()
    filters = SymbolFilters(
        symbol=ticket.symbol.upper(),
        step_size=filters.step_size,
        min_qty=filters.min_qty,
        min_notional=filters.min_notional,
        tick_size=filters.tick_size,
    )
    sizing_result = None
    if not account_state.is_stale:
        sizing_result = size_position(
            symbol=ticket.symbol.upper(),
            side=side,
            balance=account_state.balance,
            entry_price=ticket.entry_price,
            stop_price=ticket.stop_price,
            risk_fraction=ticket.risk_percent / Decimal("100"),
            filters=filters,
            leverage=ticket.leverage,
        )
    # proposed_notional_percent: notional as % of balance (for correlated-exposure check)
    proposed_notional_percent = (
        sizing_result.notional / account_state.balance * Decimal("100")
        if sizing_result is not None and account_state.balance > 0
        else Decimal("0")
    )

    # 4. Trade Proposal
    proposal = TradeProposal(
        symbol=ticket.symbol.upper(),
        side=side,
        entry_price=ticket.entry_price,
        stop_price=ticket.stop_price,
        take_profit_price=ticket.take_profit_price,
        risk_percent=ticket.risk_percent,
        leverage=ticket.leverage,
        correlation_bucket=ticket.correlation_bucket,
        proposed_notional_percent=proposed_notional_percent,
    )

    # 5. Risk engine (pure — no I/O)
    decision: PermitDecision = evaluate_permit(
        proposal=proposal,
        account_state=account_state,
        constitution=constitution,
        now=now,
        session=session,
    )

    # 6. Trade Quality Score
    rr = _compute_rr(ticket.entry_price, ticket.stop_price, ticket.take_profit_price, side)
    quality_input = TradeQualityInput(
        risk_reward_ratio=rr,
        min_risk_reward=constitution.min_risk_reward,
        stop_placement=StopPlacementQuality(ticket.stop_placement),
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
            account_state.exposure_by_bucket_percent.get(ticket.correlation_bucket, Decimal("0"))
        ),
        max_correlated_exposure_percent=constitution.max_correlated_exposure_percent,
        stop_distance_percent=_stop_distance_pct(ticket.entry_price, ticket.stop_price),
        atr_percent=ticket.atr_percent,
        session=session,
        allowed_sessions=tuple(constitution.allowed_sessions),
        is_high_liquidity_window=ticket.is_high_liquidity_window,
        behavior_flags=tuple(account_state.active_behavior_flags),
    )
    quality = score_trade_quality(quality_input)

    # 7. Persist permit (approved and rejected both — EDR 0020 decision 6)
    permit = await create_permit(
        db=db,
        user_id=user_id,
        proposal=proposal,
        account_state=account_state,
        decision=decision,
        quality=quality,
    )

    # 8. Build permit card
    card = build_permit_card(
        permit_id=permit.id,
        decision=decision,
        quality=quality,
        expires_at=permit.expires_at,
    )
    return card, permit.id
