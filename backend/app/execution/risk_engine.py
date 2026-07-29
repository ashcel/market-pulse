"""Risk engine core — M9-T2 (EDR 0020 decision 2).

A **pure, deterministic** decision function: `(proposal, account_state,
constitution, now, session) -> PermitDecision`. This is the desk that turns
a trade ticket into an `APPROVED`/`REJECTED` Trade Permit. It is the one
place every hard rule from EDR 0020 decision 2 ("The Trading Constitution is
deterministic server-side code, not LLM judgment") is enumerated and
checked.

Hard requirements this module exists to satisfy (see M9 "Hard invariants"
and EDR 0020 decision 2):

- No DB, no network, no clock reads. `now` and `session` are supplied by the
  caller; nothing in here calls `datetime.now()`, opens a socket, or touches
  Postgres. A dedicated purity-guard test
  (`tests/test_execution_risk_engine.py`) parses this module's AST to prove
  it imports nothing DB/network-shaped.
- No AI input anywhere — every field on `TradeProposal`/`AccountState` is a
  deterministic, already-computed number or flag. There is no
  "recommendation" or "confidence" field for an LLM to populate, and no
  override parameter of any kind: a `REJECTED` decision cannot be flipped to
  `APPROVED` by any caller-supplied argument. Every check is independent and
  additive — the overall decision is `APPROVED` iff *every* check passes.
- Reasons are typed enums (`PermitCheck`), never free text — `detail` on
  `PermitCheckResult` is human-readable context only, never load-bearing.

Reuses, rather than redefines, wave-1 primitives:

- `Side` comes from `app.execution.sizing` (do not redefine LONG/SHORT
  here).
- The constitution's shape is the same `ConstitutionInput` Protocol
  `validation.py` already defines (a plain dataclass satisfies it
  structurally in tests) — this module never imports the SQLAlchemy
  `TradingConstitution` model, which would break purity.
- `RISK_PER_TRADE_MIN_PERCENT` / `RISK_PER_TRADE_MAX_PERCENT` come from
  `app.execution.constants` — the same band `validation.py` enforces at
  constitution-write time.

Position sizing itself (quantity/notional/leverage/liquidation) is
`sizing.size_position`'s job, not this module's — `TradeProposal` carries
the *results* a caller already derived from it
(`proposed_notional_percent`), so this module never re-derives money math
sizing.py already owns. The test file constructs its fixtures by calling
`sizing.size_position` directly so the numbers used here are the same
`Decimal`-exact figures the sizing module guarantees, rather than
reinventing parallel arithmetic.
"""

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from .constants import (
    DEFAULT_MAINTENANCE_MARGIN_RATE,
    LIQ_STOP_BUFFER,
    RISK_PER_TRADE_MAX_PERCENT,
    RISK_PER_TRADE_MIN_PERCENT,
)
from .sizing import Side
from .validation import ConstitutionInput


class PermitCheck(StrEnum):
    """Every hard check enumerated in EDR 0020 decision 2 + the M9-T1
    constitution fields, one enum member per check. Doubles as the
    rejection *reason* when a check fails — one check, one reason, no free
    text. Order here is the fixed evaluation order `evaluate_permit` uses.
    """

    RISK_PCT_OUT_OF_BAND = "RISK_PCT_OUT_OF_BAND"
    DAILY_LOSS_LIMIT = "DAILY_LOSS_LIMIT"
    WEEKLY_LOSS_LIMIT = "WEEKLY_LOSS_LIMIT"
    MAX_LEVERAGE = "MAX_LEVERAGE"
    MAX_CONCURRENT_POSITIONS = "MAX_CONCURRENT_POSITIONS"
    MAX_CORRELATED_EXPOSURE = "MAX_CORRELATED_EXPOSURE"
    RR_BELOW_MIN = "RR_BELOW_MIN"
    STOP_MISSING = "STOP_MISSING"
    LIQUIDATION_INSIDE_STOP = "LIQUIDATION_INSIDE_STOP"
    SYMBOL_NOT_ALLOWED = "SYMBOL_NOT_ALLOWED"
    SESSION_NOT_ALLOWED = "SESSION_NOT_ALLOWED"
    STALE_ACCOUNT_STATE = "STALE_ACCOUNT_STATE"
    BINDING_COOLDOWN_ACTIVE = "BINDING_COOLDOWN_ACTIVE"


class PermitStatus(StrEnum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


# Fixed evaluation order — also the order `PermitDecision.checks` is
# reported in, so a permit card can render checks in a stable, meaningful
# sequence (mandatory-stop and band checks before portfolio-level ones).
CHECK_ORDER: tuple[PermitCheck, ...] = (
    PermitCheck.RISK_PCT_OUT_OF_BAND,
    PermitCheck.DAILY_LOSS_LIMIT,
    PermitCheck.WEEKLY_LOSS_LIMIT,
    PermitCheck.MAX_LEVERAGE,
    PermitCheck.MAX_CONCURRENT_POSITIONS,
    PermitCheck.MAX_CORRELATED_EXPOSURE,
    PermitCheck.RR_BELOW_MIN,
    PermitCheck.STOP_MISSING,
    PermitCheck.LIQUIDATION_INSIDE_STOP,
    PermitCheck.SYMBOL_NOT_ALLOWED,
    PermitCheck.SESSION_NOT_ALLOWED,
    PermitCheck.STALE_ACCOUNT_STATE,
    PermitCheck.BINDING_COOLDOWN_ACTIVE,
)


@dataclass(frozen=True, slots=True)
class TradeProposal:
    """The ticket: what the user wants to do. Every field here is either a
    deterministic input the user typed/picked (symbol, side, prices,
    leverage) or a number already derived by `sizing.size_position` for
    this specific ticket (`proposed_notional_percent`) — nothing on this
    type is AI-generated or a raw quantity (EDR 0020 decision 1: "the user
    never enters a quantity").

    `stop_price` / `take_profit_price` are `None`-able on purpose: a ticket
    can be submitted before a stop/target is attached, and the whole point
    of `STOP_MISSING` / `RR_BELOW_MIN` is to catch exactly that rather than
    assume a value that was never evidenced.
    """

    symbol: str
    side: Side
    entry_price: Decimal
    stop_price: Decimal | None
    take_profit_price: Decimal | None
    risk_percent: Decimal
    leverage: Decimal
    correlation_bucket: str
    proposed_notional_percent: Decimal
    # F2 inputs. `liquidation_price` is the isolated-equivalent estimate the
    # sizing module already derived for this exact ticket (None at leverage 1
    # or when sizing didn't run) — this module never re-derives it. For a
    # CROSSED proposal it is the conservative isolated-equivalent figure
    # (sizing tags it via `liquidation_model`), which is safe to gate on.
    # `margin_type` is the user-chosen mode carried through for the F1 sync
    # and the permit snapshot; it does not change any check arithmetic here.
    liquidation_price: Decimal | None = None
    margin_type: str = "ISOLATED"


@dataclass(frozen=True, slots=True)
class AccountState:
    """A snapshot of account state the permit is judged against (Phase-B's
    account service populates this for real; tests build it directly).

    All fields are plain numbers/flags — no client, no query, no clock.
    `is_stale` is the one field that exists specifically to make
    `STALE_ACCOUNT_STATE` representable: whatever produced this snapshot
    (a cache, a poll) is responsible for setting it, this module only
    reads it and fails closed.
    """

    balance: Decimal
    open_position_count: int
    daily_realized_pnl_percent: Decimal
    weekly_realized_pnl_percent: Decimal
    exposure_by_bucket_percent: dict[str, Decimal] = field(default_factory=dict)
    active_behavior_flags: frozenset[str] = field(default_factory=frozenset)
    is_stale: bool = False


@dataclass(frozen=True, slots=True)
class PermitCheckResult:
    check: PermitCheck
    passed: bool
    detail: str


@dataclass(frozen=True, slots=True)
class PermitDecision:
    """The permit's decision core. `status` is `APPROVED` iff every check in
    `checks` passed — there is no other path to `APPROVED`, and no field
    here a caller can set to force it. `reasons` is the failing subset of
    `checks`, in `CHECK_ORDER`, as typed enums.
    """

    status: PermitStatus
    checks: tuple[PermitCheckResult, ...]
    reasons: tuple[PermitCheck, ...]
    evaluated_at: datetime
    session: str


def _check_risk_pct_out_of_band(
    proposal: TradeProposal, constitution: ConstitutionInput
) -> PermitCheckResult:
    band_ok = RISK_PER_TRADE_MIN_PERCENT <= proposal.risk_percent <= RISK_PER_TRADE_MAX_PERCENT
    within_configured = proposal.risk_percent <= Decimal(str(constitution.risk_per_trade_percent))
    passed = band_ok and within_configured
    detail = (
        f"requested risk {proposal.risk_percent}% within "
        f"[{RISK_PER_TRADE_MIN_PERCENT}, {RISK_PER_TRADE_MAX_PERCENT}] and "
        f"<= configured {constitution.risk_per_trade_percent}%"
        if passed
        else (
            f"requested risk {proposal.risk_percent}% violates band "
            f"[{RISK_PER_TRADE_MIN_PERCENT}, {RISK_PER_TRADE_MAX_PERCENT}] or exceeds "
            f"configured {constitution.risk_per_trade_percent}%"
        )
    )
    return PermitCheckResult(PermitCheck.RISK_PCT_OUT_OF_BAND, passed, detail)


def _check_daily_loss_limit(
    account_state: AccountState, constitution: ConstitutionInput
) -> PermitCheckResult:
    limit = Decimal(str(constitution.daily_loss_limit_percent))
    already_lost = -account_state.daily_realized_pnl_percent
    passed = not (limit > 0 and already_lost >= limit)
    detail = f"today's realized loss {already_lost}% vs limit {limit}%"
    return PermitCheckResult(PermitCheck.DAILY_LOSS_LIMIT, passed, detail)


def _check_weekly_loss_limit(
    account_state: AccountState, constitution: ConstitutionInput
) -> PermitCheckResult:
    limit = Decimal(str(constitution.weekly_loss_limit_percent))
    already_lost = -account_state.weekly_realized_pnl_percent
    passed = not (limit > 0 and already_lost >= limit)
    detail = f"this week's realized loss {already_lost}% vs limit {limit}%"
    return PermitCheckResult(PermitCheck.WEEKLY_LOSS_LIMIT, passed, detail)


def _check_max_leverage(
    proposal: TradeProposal, constitution: ConstitutionInput
) -> PermitCheckResult:
    max_leverage = Decimal(str(constitution.max_leverage))
    passed = proposal.leverage <= max_leverage
    detail = f"requested leverage {proposal.leverage}x vs max {max_leverage}x"
    return PermitCheckResult(PermitCheck.MAX_LEVERAGE, passed, detail)


def _check_max_concurrent_positions(
    account_state: AccountState, constitution: ConstitutionInput
) -> PermitCheckResult:
    passed = account_state.open_position_count < constitution.max_concurrent_positions
    detail = (
        f"open positions {account_state.open_position_count} vs max "
        f"{constitution.max_concurrent_positions}"
    )
    return PermitCheckResult(PermitCheck.MAX_CONCURRENT_POSITIONS, passed, detail)


def _check_max_correlated_exposure(
    proposal: TradeProposal, account_state: AccountState, constitution: ConstitutionInput
) -> PermitCheckResult:
    current = account_state.exposure_by_bucket_percent.get(
        proposal.correlation_bucket, Decimal("0")
    )
    projected = current + proposal.proposed_notional_percent
    max_exposure = Decimal(str(constitution.max_correlated_exposure_percent))
    passed = projected <= max_exposure
    detail = (
        f"bucket '{proposal.correlation_bucket}' projected exposure {projected}% "
        f"(current {current}% + proposed {proposal.proposed_notional_percent}%) vs max "
        f"{max_exposure}%"
    )
    return PermitCheckResult(PermitCheck.MAX_CORRELATED_EXPOSURE, passed, detail)


def _risk_reward(proposal: TradeProposal) -> Decimal:
    # Only called once the caller has confirmed stop_price is not None
    # (see `_check_rr_below_min`); still defensive here in case that
    # invariant is ever relaxed.
    if proposal.stop_price is None or proposal.take_profit_price is None:
        return Decimal("0")
    if proposal.side is Side.LONG:
        risk_distance = proposal.entry_price - proposal.stop_price
        reward_distance = proposal.take_profit_price - proposal.entry_price
    else:
        risk_distance = proposal.stop_price - proposal.entry_price
        reward_distance = proposal.entry_price - proposal.take_profit_price
    if risk_distance <= 0 or reward_distance <= 0:
        return Decimal("0")
    return reward_distance / risk_distance


def _check_rr_below_min(
    proposal: TradeProposal, constitution: ConstitutionInput
) -> PermitCheckResult:
    if proposal.stop_price is None:
        # STOP_MISSING already owns this failure mode — keep this check
        # independent rather than double-failing on the same missing input.
        return PermitCheckResult(
            PermitCheck.RR_BELOW_MIN,
            True,
            "stop missing — R:R not evaluated (see STOP_MISSING)",
        )
    rr = _risk_reward(proposal)
    min_rr = Decimal(str(constitution.min_risk_reward))
    passed = rr >= min_rr
    detail = f"computed R:R {rr} vs minimum {min_rr}"
    return PermitCheckResult(PermitCheck.RR_BELOW_MIN, passed, detail)


def _check_stop_missing(proposal: TradeProposal) -> PermitCheckResult:
    passed = proposal.stop_price is not None
    detail = "stop attached" if passed else "no stop price on proposal"
    return PermitCheckResult(PermitCheck.STOP_MISSING, passed, detail)


def _max_leverage_that_passes(
    entry: Decimal, stop_distance: Decimal, buffer_fraction: Decimal
) -> Decimal | None:
    """The largest leverage whose isolated liquidation would still sit the
    required buffer beyond the stop, for the F2 rejection hint only.

    Closed form (long and short are symmetric, `d` = stop distance):
        liq is 1/L - mmr away from entry as a fraction; requiring the stop's
        buffer gives  1/L >= mmr + (1 + buffer) * d / entry, i.e.
        L <= 1 / (mmr + (1 + buffer) * d / entry).
    Returns None if the geometry admits no leverage > 0 (denominator <= 0),
    which can't happen for positive inputs but is guarded defensively. This
    is a human-readable steer (`detail` only), never load-bearing — it reuses
    the same flat MMR the sizing estimate uses so the two agree.
    """
    if entry <= 0 or stop_distance <= 0:
        return None
    denom = DEFAULT_MAINTENANCE_MARGIN_RATE + (Decimal(1) + buffer_fraction) * stop_distance / entry
    if denom <= 0:
        return None
    return Decimal(1) / denom


def _check_liquidation_inside_stop(proposal: TradeProposal) -> PermitCheckResult:
    """Hard check (F2): the estimated liquidation must sit at least
    ``LIQ_STOP_BUFFER`` x stop-distance BEYOND the stop, in the adverse
    direction — otherwise the exchange could liquidate before the stop fires
    and the mandatory-stop invariant is silently void.

    Leverage 1 (or any proposal without a liquidation estimate) has no
    liquidation risk to compare and passes. The comparison runs against the
    sizing module's isolated-equivalent estimate (conservative for cross), so
    it never approves a position the real liquidation would endanger.
    """
    liq = proposal.liquidation_price
    if liq is None or proposal.stop_price is None:
        return PermitCheckResult(
            PermitCheck.LIQUIDATION_INSIDE_STOP,
            True,
            "no liquidation estimate (leverage 1 or unsized) — not applicable",
        )

    stop_distance = abs(proposal.entry_price - proposal.stop_price)
    if stop_distance <= 0:
        # STOP_MISSING / sizing own a zero/invalid stop distance; don't
        # double-fail here on the same degenerate input.
        return PermitCheckResult(
            PermitCheck.LIQUIDATION_INSIDE_STOP,
            True,
            "stop distance is zero — liquidation buffer not evaluated",
        )

    required_buffer = LIQ_STOP_BUFFER * stop_distance
    if proposal.side is Side.LONG:
        # Long: both stop and liquidation are below entry; liquidation must be
        # further below (smaller) than the stop by the required buffer.
        gap_beyond_stop = proposal.stop_price - liq
    else:
        # Short: both are above entry; liquidation must be further above.
        gap_beyond_stop = liq - proposal.stop_price

    passed = gap_beyond_stop >= required_buffer
    if passed:
        detail = (
            f"liquidation {liq} sits {gap_beyond_stop} beyond stop "
            f"{proposal.stop_price} (>= required buffer {required_buffer} = "
            f"{LIQ_STOP_BUFFER} x stop distance {stop_distance})"
        )
    else:
        max_lev = _max_leverage_that_passes(proposal.entry_price, stop_distance, LIQ_STOP_BUFFER)
        max_lev_hint = (
            f"reduce leverage to <= {max_lev.quantize(Decimal('0.01'))}x"
            if max_lev is not None
            else "reduce leverage"
        )
        detail = (
            f"liquidation {liq} is only {gap_beyond_stop} beyond stop "
            f"{proposal.stop_price}, inside the required buffer {required_buffer} "
            f"({LIQ_STOP_BUFFER} x stop distance {stop_distance}) at "
            f"{proposal.leverage}x — {max_lev_hint}"
        )
    return PermitCheckResult(PermitCheck.LIQUIDATION_INSIDE_STOP, passed, detail)


def _check_symbol_not_allowed(
    proposal: TradeProposal, constitution: ConstitutionInput
) -> PermitCheckResult:
    # An empty allow-list means the constitution hasn't scoped symbols —
    # treated as "no restriction configured" rather than "block everything".
    passed = not constitution.allowed_symbols or proposal.symbol in constitution.allowed_symbols
    detail = f"symbol '{proposal.symbol}' vs allow-list {list(constitution.allowed_symbols)}"
    return PermitCheckResult(PermitCheck.SYMBOL_NOT_ALLOWED, passed, detail)


def _check_session_not_allowed(constitution: ConstitutionInput, session: str) -> PermitCheckResult:
    # Same "empty = unrestricted" convention as the symbol allow-list.
    passed = not constitution.allowed_sessions or session in constitution.allowed_sessions
    detail = f"session '{session}' vs allow-list {list(constitution.allowed_sessions)}"
    return PermitCheckResult(PermitCheck.SESSION_NOT_ALLOWED, passed, detail)


def _check_stale_account_state(account_state: AccountState) -> PermitCheckResult:
    passed = not account_state.is_stale
    detail = "account state fresh" if passed else "account state is stale — fail closed"
    return PermitCheckResult(PermitCheck.STALE_ACCOUNT_STATE, passed, detail)


def _check_binding_cooldown_active(
    account_state: AccountState, constitution: ConstitutionInput
) -> PermitCheckResult:
    triggered = sorted(
        flag
        for flag in account_state.active_behavior_flags
        if constitution.binding_cooldowns.get(flag) is True
    )
    passed = not triggered
    detail = (
        "no binding behavior cooldown active"
        if passed
        else f"binding cooldown active for: {', '.join(triggered)}"
    )
    return PermitCheckResult(PermitCheck.BINDING_COOLDOWN_ACTIVE, passed, detail)


def evaluate_permit(
    proposal: TradeProposal,
    account_state: AccountState,
    constitution: ConstitutionInput,
    *,
    now: datetime,
    session: str,
) -> PermitDecision:
    """Judge one trade proposal against one constitution + account snapshot.

    Pure and total: every check in `CHECK_ORDER` is always evaluated and
    always reported, whether or not earlier checks failed — there is no
    short-circuiting, so a permit card can show the full board (this is
    also why the fixture matrix can assert several rules failing at once).
    `now`/`session` are caller-supplied context, never read from a clock or
    derived from wall time in here.

    `status` is `APPROVED` if and only if every check passed. There is no
    parameter, flag, or code path in this function that can produce
    `APPROVED` while any check's `passed` is `False` — the only way to
    flip a rejection is to change the inputs (a new proposal, a new
    constitution version, fresher account state), never to call this
    function differently.
    """
    checks: dict[PermitCheck, PermitCheckResult] = {
        PermitCheck.RISK_PCT_OUT_OF_BAND: _check_risk_pct_out_of_band(proposal, constitution),
        PermitCheck.DAILY_LOSS_LIMIT: _check_daily_loss_limit(account_state, constitution),
        PermitCheck.WEEKLY_LOSS_LIMIT: _check_weekly_loss_limit(account_state, constitution),
        PermitCheck.MAX_LEVERAGE: _check_max_leverage(proposal, constitution),
        PermitCheck.MAX_CONCURRENT_POSITIONS: _check_max_concurrent_positions(
            account_state, constitution
        ),
        PermitCheck.MAX_CORRELATED_EXPOSURE: _check_max_correlated_exposure(
            proposal, account_state, constitution
        ),
        PermitCheck.RR_BELOW_MIN: _check_rr_below_min(proposal, constitution),
        PermitCheck.STOP_MISSING: _check_stop_missing(proposal),
        PermitCheck.LIQUIDATION_INSIDE_STOP: _check_liquidation_inside_stop(proposal),
        PermitCheck.SYMBOL_NOT_ALLOWED: _check_symbol_not_allowed(proposal, constitution),
        PermitCheck.SESSION_NOT_ALLOWED: _check_session_not_allowed(constitution, session),
        PermitCheck.STALE_ACCOUNT_STATE: _check_stale_account_state(account_state),
        PermitCheck.BINDING_COOLDOWN_ACTIVE: _check_binding_cooldown_active(
            account_state, constitution
        ),
    }

    ordered = tuple(checks[c] for c in CHECK_ORDER)
    reasons = tuple(result.check for result in ordered if not result.passed)
    status = PermitStatus.REJECTED if reasons else PermitStatus.APPROVED

    return PermitDecision(
        status=status,
        checks=ordered,
        reasons=reasons,
        evaluated_at=now,
        session=session,
    )
