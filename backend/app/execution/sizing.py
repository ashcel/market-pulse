"""Position sizing — M9-T3 (EDR 0020 decision 1 sizing clause).

Pure math only: no DB, no network, no router. Given account balance, entry
price, stop price, a configured risk fraction, and the exchange's symbol
filters, this module derives the quantity to trade. The caller (a future
ticket UI) never supplies a raw quantity — it only supplies stop distance
(via entry+stop) and the constitution's risk-per-trade band. See EDR 0020's
"Synthesized position sizing inputs" rejection: no volatility-guessed
stops, nothing here invents a number that wasn't given.

Money math uses `Decimal` (not the codebase's usual `float`) because the
one invariant this module exists to prove — quantity rounds DOWN to an
exact multiple of the exchange step size, never up, so realized risk never
exceeds the configured % — must hold exactly, not "within float epsilon".
Callers may still pass plain `float`/`int`; they're coerced via
`Decimal(str(x))` to avoid binary-float representation error.

Live filter fetch (Binance `exchangeInfo`) is a later task. This module
only consumes `SymbolFilters` as a value object and ships fixtures for
spot + perp so `risk_engine.py` (M9-T2) and tests have something real to
size against.
"""

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
from enum import StrEnum
from typing import Final

# EDR 0020 decision 1 / M9-T1: risk-per-trade band the Trading Constitution
# is allowed to configure. Enforced here defensively — this module has no
# way to read the constitution, but a caller passing a fraction outside the
# band is a programming error, not a market condition.
MIN_RISK_FRACTION: Final = Decimal("0.005")
MAX_RISK_FRACTION: Final = Decimal("0.03")

DecimalLike = Decimal | float | int


def _to_decimal(value: DecimalLike) -> Decimal:
    """Coerce to `Decimal` via `str()` so `0.01` never becomes the binary
    float's nearest neighbor instead of the literal decimal typed."""
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _round_down_to_step(value: Decimal, step: Decimal) -> Decimal:
    """Floor `value` to the nearest multiple of `step`, never up.

    Exact under `Decimal` arithmetic (no float rounding surprises) as long
    as `step` itself is an exact decimal (e.g. "0.001"), which every
    Binance LOT_SIZE stepSize is.
    """
    if step <= 0:
        raise ValueError("step must be positive")
    steps = (value / step).to_integral_value(rounding=ROUND_DOWN)
    return steps * step


def _is_on_tick(price: Decimal, tick_size: Decimal) -> bool:
    """True if `price` is an exact multiple of `tick_size`.

    Prices come from the caller (live market data / the ticket), never
    guessed here — this only validates they're already exchange-valid.
    """
    if tick_size <= 0:
        return False
    remainder = price % tick_size
    return remainder == 0 or remainder == tick_size


class Side(StrEnum):
    LONG = "long"
    SHORT = "short"


class SizingRejectReason(StrEnum):
    """Enumerated, not free text — mirrors the Trade Permit's rejection
    contract (EDR 0020 decision 6): callers can branch on this."""

    INVALID_STOP = "invalid_stop"
    PRICE_NOT_ON_TICK = "price_not_on_tick"
    BELOW_MIN_QTY = "below_min_qty"
    BELOW_MIN_NOTIONAL = "below_min_notional"


@dataclass(frozen=True)
class SymbolFilters:
    """The subset of Binance `exchangeInfo` filters sizing needs.

    step_size:    LOT_SIZE stepSize — quantity must be an integer multiple.
    min_qty:      LOT_SIZE minQty.
    min_notional: MIN_NOTIONAL / NOTIONAL filter minimum (quote currency).
    tick_size:    PRICE_FILTER tickSize — validates entry/stop, never used
                  to derive them.
    """

    symbol: str
    step_size: Decimal
    min_qty: Decimal
    min_notional: Decimal
    tick_size: Decimal


@dataclass(frozen=True)
class SizingResult:
    """Always returned — approved with numbers, or flagged with a reason.

    Never silently violates the risk budget: if the exchange minimums
    can't be met inside the configured risk fraction, `approved` is False
    and every downstream number (notional, margin, leverage, liquidation)
    is zeroed/None rather than reporting a non-executable size as real.
    """

    approved: bool
    symbol: str
    side: Side
    entry_price: Decimal
    stop_price: Decimal
    stop_distance: Decimal
    risk_fraction: Decimal
    risk_amount: Decimal
    quantity: Decimal
    notional: Decimal
    required_margin: Decimal
    effective_leverage: Decimal
    liquidation_price: Decimal | None
    realized_risk_amount: Decimal
    realized_risk_fraction: Decimal
    reject_reason: SizingRejectReason | None = None


def size_position(
    *,
    symbol: str,
    side: Side | str,
    balance: DecimalLike,
    entry_price: DecimalLike,
    stop_price: DecimalLike,
    risk_fraction: DecimalLike,
    filters: SymbolFilters,
    leverage: DecimalLike = Decimal("1"),
    maintenance_margin_rate: DecimalLike = Decimal("0.005"),
) -> SizingResult:
    """Derive quantity from balance, stop distance, and configured risk.

    The user never enters a quantity — that's the whole point (EDR 0020
    decision 1). Raises `ValueError` for programming/config misuse
    (out-of-band risk fraction, non-positive balance/price/leverage,
    non-positive filter values) since those aren't market conditions a
    ticket UI would ever legitimately hit. Market-driven "can't size this"
    conditions (stop on the wrong side, sub-tick prices, below exchange
    minimums) come back as a flagged `SizingResult`, never an exception.
    """
    side = Side(side) if isinstance(side, str) else side
    balance_d = _to_decimal(balance)
    entry_d = _to_decimal(entry_price)
    stop_d = _to_decimal(stop_price)
    risk_fraction_d = _to_decimal(risk_fraction)
    leverage_d = _to_decimal(leverage)
    mmr_d = _to_decimal(maintenance_margin_rate)

    if not (MIN_RISK_FRACTION <= risk_fraction_d <= MAX_RISK_FRACTION):
        raise ValueError(
            f"risk_fraction {risk_fraction_d} outside configured band "
            f"[{MIN_RISK_FRACTION}, {MAX_RISK_FRACTION}]"
        )
    if balance_d <= 0:
        raise ValueError("balance must be positive")
    if entry_d <= 0:
        raise ValueError("entry_price must be positive")
    if leverage_d <= 0:
        raise ValueError("leverage must be positive")
    if filters.step_size <= 0 or filters.tick_size <= 0:
        raise ValueError("filters.step_size and tick_size must be positive")
    if filters.min_qty < 0 or filters.min_notional < 0:
        raise ValueError("filters.min_qty and min_notional must be non-negative")

    risk_amount = balance_d * risk_fraction_d
    stop_distance = abs(entry_d - stop_d)

    def _rejected(
        reason: SizingRejectReason,
        *,
        quantity: Decimal = Decimal("0"),
        notional: Decimal = Decimal("0"),
        realized_risk_amount: Decimal = Decimal("0"),
    ) -> SizingResult:
        realized_risk_fraction = (
            realized_risk_amount / balance_d if balance_d > 0 else Decimal("0")
        )
        return SizingResult(
            approved=False,
            symbol=symbol,
            side=side,
            entry_price=entry_d,
            stop_price=stop_d,
            stop_distance=stop_distance,
            risk_fraction=risk_fraction_d,
            risk_amount=risk_amount,
            quantity=quantity,
            notional=notional,
            required_margin=Decimal("0"),
            effective_leverage=Decimal("0"),
            liquidation_price=None,
            realized_risk_amount=realized_risk_amount,
            realized_risk_fraction=realized_risk_fraction,
            reject_reason=reason,
        )

    # Stop distance is derived from entry/stop, never guessed — but it must
    # be a real, directionally-consistent distance to mean anything.
    if stop_distance == 0:
        return _rejected(SizingRejectReason.INVALID_STOP)
    if side is Side.LONG and stop_d >= entry_d:
        return _rejected(SizingRejectReason.INVALID_STOP)
    if side is Side.SHORT and stop_d <= entry_d:
        return _rejected(SizingRejectReason.INVALID_STOP)
    if not (_is_on_tick(entry_d, filters.tick_size) and _is_on_tick(stop_d, filters.tick_size)):
        return _rejected(SizingRejectReason.PRICE_NOT_ON_TICK)

    ideal_qty = risk_amount / stop_distance
    quantity = _round_down_to_step(ideal_qty, filters.step_size)

    if quantity <= 0 or quantity < filters.min_qty:
        realized_risk_amount = quantity * stop_distance
        return _rejected(
            SizingRejectReason.BELOW_MIN_QTY,
            quantity=quantity,
            notional=quantity * entry_d,
            realized_risk_amount=realized_risk_amount,
        )

    notional = quantity * entry_d
    if notional < filters.min_notional:
        realized_risk_amount = quantity * stop_distance
        return _rejected(
            SizingRejectReason.BELOW_MIN_NOTIONAL,
            quantity=quantity,
            notional=notional,
            realized_risk_amount=realized_risk_amount,
        )

    realized_risk_amount = quantity * stop_distance
    # The whole point of rounding DOWN: realized risk can never exceed the
    # risk budget the constitution configured. This is a guaranteed
    # algebraic consequence of quantity <= ideal_qty, asserted here as a
    # defensive invariant check, and proven across the matrix by the test
    # suite (test_execution_sizing.py).
    assert realized_risk_amount <= risk_amount, (
        "rounding-down invariant violated: realized risk exceeds configured budget"
    )
    realized_risk_fraction = realized_risk_amount / balance_d
    assert realized_risk_fraction <= risk_fraction_d

    required_margin = notional / leverage_d
    effective_leverage = notional / balance_d

    liquidation_price: Decimal | None = None
    if leverage_d > 1:
        # Standard simplified isolated-margin liquidation estimate
        # (ignores funding, fees, and tiered maintenance-margin brackets —
        # an estimate, not an exact exchange figure):
        #   long:  liq = entry * (1 - 1/leverage + mmr)
        #   short: liq = entry * (1 + 1/leverage - mmr)
        inv_leverage = Decimal(1) / leverage_d
        if side is Side.LONG:
            liquidation_price = entry_d * (Decimal(1) - inv_leverage + mmr_d)
        else:
            liquidation_price = entry_d * (Decimal(1) + inv_leverage - mmr_d)

    return SizingResult(
        approved=True,
        symbol=symbol,
        side=side,
        entry_price=entry_d,
        stop_price=stop_d,
        stop_distance=stop_distance,
        risk_fraction=risk_fraction_d,
        risk_amount=risk_amount,
        quantity=quantity,
        notional=notional,
        required_margin=required_margin,
        effective_leverage=effective_leverage,
        liquidation_price=liquidation_price,
        realized_risk_amount=realized_risk_amount,
        realized_risk_fraction=realized_risk_fraction,
        reject_reason=None,
    )


# ---------------------------------------------------------------------------
# Symbol filter fixtures — spot + perp, including a low-price perp.
#
# Illustrative realistic values (Binance's actual `exchangeInfo` filters
# move over time and vary by tier); live filter fetch is a later task
# (M9-T6/T7 territory). These exist so this module's tests, and
# `risk_engine.py` fixtures (M9-T2), have real numbers to size against.
# ---------------------------------------------------------------------------

BTCUSDT_SPOT_FILTERS = SymbolFilters(
    symbol="BTCUSDT",
    step_size=Decimal("0.00001"),
    min_qty=Decimal("0.00001"),
    min_notional=Decimal("5"),
    tick_size=Decimal("0.01"),
)

ETHUSDT_SPOT_FILTERS = SymbolFilters(
    symbol="ETHUSDT",
    step_size=Decimal("0.0001"),
    min_qty=Decimal("0.0001"),
    min_notional=Decimal("5"),
    tick_size=Decimal("0.01"),
)

BTCUSDT_PERP_FILTERS = SymbolFilters(
    symbol="BTCUSDT",
    step_size=Decimal("0.001"),
    min_qty=Decimal("0.001"),
    min_notional=Decimal("5"),
    tick_size=Decimal("0.1"),
)

ETHUSDT_PERP_FILTERS = SymbolFilters(
    symbol="ETHUSDT",
    step_size=Decimal("0.001"),
    min_qty=Decimal("0.001"),
    min_notional=Decimal("5"),
    tick_size=Decimal("0.01"),
)

# Low-price perp: small notional-per-unit means step/tick sizing matters
# much more (whole-unit lot steps, sub-cent ticks).
DOGEUSDT_PERP_FILTERS = SymbolFilters(
    symbol="DOGEUSDT",
    step_size=Decimal("1"),
    min_qty=Decimal("1"),
    min_notional=Decimal("5"),
    tick_size=Decimal("0.00001"),
)

SYMBOL_FILTER_FIXTURES: Final[dict[str, SymbolFilters]] = {
    "BTCUSDT_SPOT": BTCUSDT_SPOT_FILTERS,
    "ETHUSDT_SPOT": ETHUSDT_SPOT_FILTERS,
    "BTCUSDT_PERP": BTCUSDT_PERP_FILTERS,
    "ETHUSDT_PERP": ETHUSDT_PERP_FILTERS,
    "DOGEUSDT_PERP": DOGEUSDT_PERP_FILTERS,
}
