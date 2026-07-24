"""Property-style tests for the pure position-sizing module (M9-T3).

No DB, no network, no app import beyond `app.execution.sizing` itself —
`conftest.py` still imports `app.main` for the shared `client` fixture, but
nothing here uses it, so this file is safe to run in isolation:

    cd backend && .venv/bin/python -m pytest tests/test_execution_sizing.py -q

Matrix covers the DoD's five assertions:
  1. realized risk <= configured % (within step-size rounding tolerance)
  2. quantity is an exact multiple of the symbol's step size
  3. rounding is always down, never up, vs the un-rounded ideal quantity
  4. below-min-notional / below-min-qty inputs produce the flagged result
  5. liquidation estimate lands on the correct side of entry and is
     monotonic in leverage
"""

import itertools
from decimal import ROUND_HALF_UP, Decimal

import pytest

from app.execution.sizing import (
    BTCUSDT_PERP_FILTERS,
    BTCUSDT_SPOT_FILTERS,
    DOGEUSDT_PERP_FILTERS,
    ETHUSDT_PERP_FILTERS,
    ETHUSDT_SPOT_FILTERS,
    MAX_RISK_FRACTION,
    MIN_RISK_FRACTION,
    Side,
    SizingRejectReason,
    SymbolFilters,
    size_position,
)

FIXTURES: dict[str, SymbolFilters] = {
    "BTCUSDT_SPOT": BTCUSDT_SPOT_FILTERS,
    "ETHUSDT_SPOT": ETHUSDT_SPOT_FILTERS,
    "BTCUSDT_PERP": BTCUSDT_PERP_FILTERS,
    "ETHUSDT_PERP": ETHUSDT_PERP_FILTERS,
    "DOGEUSDT_PERP": DOGEUSDT_PERP_FILTERS,
}

# A representative "current price" per fixture, already aligned to that
# fixture's tick size.
ENTRY_PRICES: dict[str, Decimal] = {
    "BTCUSDT_SPOT": Decimal("65000.00"),
    "ETHUSDT_SPOT": Decimal("3500.00"),
    "BTCUSDT_PERP": Decimal("65000.0"),
    "ETHUSDT_PERP": Decimal("3500.00"),
    "DOGEUSDT_PERP": Decimal("0.12000"),
}

BALANCES = [Decimal("500"), Decimal("5000"), Decimal("250000")]
RISK_FRACTIONS = [Decimal("0.005"), Decimal("0.01"), Decimal("0.02"), Decimal("0.03")]
SIDES = [Side.LONG, Side.SHORT]
STOP_DISTANCE_PCTS = [Decimal("0.005"), Decimal("0.02"), Decimal("0.10")]


def _align_to_tick(price: Decimal, tick: Decimal) -> Decimal:
    steps = (price / tick).to_integral_value(rounding=ROUND_HALF_UP)
    return steps * tick


def _stop_for(entry: Decimal, side: Side, pct: Decimal, tick: Decimal) -> Decimal:
    raw = entry * (Decimal(1) - pct) if side is Side.LONG else entry * (Decimal(1) + pct)
    return _align_to_tick(raw, tick)


MATRIX = list(
    itertools.product(
        FIXTURES.keys(),
        BALANCES,
        RISK_FRACTIONS,
        SIDES,
        STOP_DISTANCE_PCTS,
    )
)


def _size(
    fixture_name: str, balance: Decimal, risk_fraction: Decimal, side: Side, stop_pct: Decimal
):
    filters = FIXTURES[fixture_name]
    entry = ENTRY_PRICES[fixture_name]
    stop = _stop_for(entry, side, stop_pct, filters.tick_size)
    result = size_position(
        symbol=filters.symbol,
        side=side,
        balance=balance,
        entry_price=entry,
        stop_price=stop,
        risk_fraction=risk_fraction,
        filters=filters,
    )
    return result, filters, entry, stop


@pytest.mark.parametrize(("fixture_name", "balance", "risk_fraction", "side", "stop_pct"), MATRIX)
def test_realized_risk_never_exceeds_configured_budget(
    fixture_name, balance, risk_fraction, side, stop_pct
):
    result, *_ = _size(fixture_name, balance, risk_fraction, side, stop_pct)

    if not result.approved:
        # Only the exchange-minimum guards are allowed to reject here — the
        # inputs are all otherwise valid (in-band risk, correctly-sided,
        # tick-aligned stop).
        assert result.reject_reason in (
            SizingRejectReason.BELOW_MIN_QTY,
            SizingRejectReason.BELOW_MIN_NOTIONAL,
        )
        return

    risk_amount = balance * risk_fraction
    assert result.realized_risk_amount <= risk_amount
    assert result.realized_risk_fraction <= risk_fraction


@pytest.mark.parametrize(("fixture_name", "balance", "risk_fraction", "side", "stop_pct"), MATRIX)
def test_quantity_is_exact_multiple_of_step_size(
    fixture_name, balance, risk_fraction, side, stop_pct
):
    result, filters, *_ = _size(fixture_name, balance, risk_fraction, side, stop_pct)
    if not result.approved:
        return
    steps = result.quantity / filters.step_size
    assert steps == steps.to_integral_value()


@pytest.mark.parametrize(("fixture_name", "balance", "risk_fraction", "side", "stop_pct"), MATRIX)
def test_rounding_is_always_down_never_up(fixture_name, balance, risk_fraction, side, stop_pct):
    result, filters, entry, stop = _size(fixture_name, balance, risk_fraction, side, stop_pct)
    stop_distance = abs(entry - stop)
    ideal_qty = (balance * risk_fraction) / stop_distance

    # Whether approved or flagged, the rounded-down quantity must never
    # exceed the un-rounded ideal — that's the entire invariant.
    assert result.quantity <= ideal_qty
    if result.approved:
        # And it should be the *greatest* multiple of step_size <= ideal —
        # i.e. one more step would overshoot the ideal (rounding to
        # nearest, not down, would sometimes exceed it).
        assert result.quantity + filters.step_size > ideal_qty


def test_below_min_qty_produces_flagged_result_not_silent_violation():
    filters = ETHUSDT_SPOT_FILTERS
    result = size_position(
        symbol=filters.symbol,
        side=Side.LONG,
        balance=Decimal("0.01"),
        entry_price=Decimal("3500.00"),
        stop_price=Decimal("3499.00"),  # distance = 1
        risk_fraction=Decimal("0.005"),
        filters=filters,
    )

    assert result.approved is False
    assert result.reject_reason is SizingRejectReason.BELOW_MIN_QTY
    # Flagged, not silently sized past budget:
    assert result.notional == 0
    assert result.required_margin == 0
    assert result.effective_leverage == 0
    assert result.liquidation_price is None


def test_below_min_notional_produces_flagged_result_not_silent_violation():
    filters = ETHUSDT_SPOT_FILTERS
    result = size_position(
        symbol=filters.symbol,
        side=Side.LONG,
        balance=Decimal("10"),
        entry_price=Decimal("3500.00"),
        stop_price=Decimal("3400.00"),  # distance = 100
        risk_fraction=Decimal("0.005"),  # risk_amount = 0.05 -> ideal qty 0.0005
        filters=filters,
    )

    assert result.approved is False
    assert result.reject_reason is SizingRejectReason.BELOW_MIN_NOTIONAL
    # Quantity cleared the min-qty bar but not the min-notional bar; even
    # so the result is flagged, and margin/leverage/liquidation are zeroed
    # rather than reporting a non-executable size as real.
    assert result.quantity == Decimal("0.0005")
    assert result.required_margin == 0
    assert result.effective_leverage == 0
    assert result.liquidation_price is None


@pytest.mark.parametrize("side", [Side.LONG, Side.SHORT])
def test_stop_on_wrong_side_of_entry_is_flagged_invalid(side):
    filters = BTCUSDT_SPOT_FILTERS
    entry = Decimal("65000.00")
    # Deliberately backwards: long needs stop below entry, short needs it above.
    wrong_side_stop = Decimal("66000.00") if side is Side.LONG else Decimal("64000.00")

    result = size_position(
        symbol=filters.symbol,
        side=side,
        balance=Decimal("10000"),
        entry_price=entry,
        stop_price=wrong_side_stop,
        risk_fraction=Decimal("0.01"),
        filters=filters,
    )

    assert result.approved is False
    assert result.reject_reason is SizingRejectReason.INVALID_STOP


def test_zero_stop_distance_is_flagged_invalid():
    filters = BTCUSDT_SPOT_FILTERS
    result = size_position(
        symbol=filters.symbol,
        side=Side.LONG,
        balance=Decimal("10000"),
        entry_price=Decimal("65000.00"),
        stop_price=Decimal("65000.00"),
        risk_fraction=Decimal("0.01"),
        filters=filters,
    )
    assert result.approved is False
    assert result.reject_reason is SizingRejectReason.INVALID_STOP


def test_price_not_on_tick_is_flagged():
    filters = BTCUSDT_PERP_FILTERS  # tick_size = 0.1
    result = size_position(
        symbol=filters.symbol,
        side=Side.LONG,
        balance=Decimal("10000"),
        entry_price=Decimal("65000.05"),  # not a multiple of 0.1
        stop_price=Decimal("64000.0"),
        risk_fraction=Decimal("0.01"),
        filters=filters,
    )
    assert result.approved is False
    assert result.reject_reason is SizingRejectReason.PRICE_NOT_ON_TICK


@pytest.mark.parametrize(
    "risk_fraction",
    [Decimal("0.001"), Decimal("0.004999"), Decimal("0.0301"), Decimal("0.1")],
)
def test_risk_fraction_outside_configured_band_raises(risk_fraction):
    filters = BTCUSDT_SPOT_FILTERS
    with pytest.raises(ValueError, match="risk_fraction"):
        size_position(
            symbol=filters.symbol,
            side=Side.LONG,
            balance=Decimal("10000"),
            entry_price=Decimal("65000.00"),
            stop_price=Decimal("64000.00"),
            risk_fraction=risk_fraction,
            filters=filters,
        )


@pytest.mark.parametrize("risk_fraction", [MIN_RISK_FRACTION, MAX_RISK_FRACTION])
def test_risk_fraction_at_band_boundary_is_accepted(risk_fraction):
    filters = BTCUSDT_SPOT_FILTERS
    result = size_position(
        symbol=filters.symbol,
        side=Side.LONG,
        balance=Decimal("10000"),
        entry_price=Decimal("65000.00"),
        stop_price=Decimal("64000.00"),
        risk_fraction=risk_fraction,
        filters=filters,
    )
    assert result.realized_risk_fraction <= risk_fraction


@pytest.mark.parametrize(
    ("balance", "entry_price", "leverage"),
    [
        (Decimal("-1"), Decimal("65000"), Decimal("1")),
        (Decimal("0"), Decimal("65000"), Decimal("1")),
        (Decimal("10000"), Decimal("0"), Decimal("1")),
        (Decimal("10000"), Decimal("-100"), Decimal("1")),
        (Decimal("10000"), Decimal("65000"), Decimal("0")),
        (Decimal("10000"), Decimal("65000"), Decimal("-5")),
    ],
)
def test_non_positive_config_inputs_raise(balance, entry_price, leverage):
    filters = BTCUSDT_SPOT_FILTERS
    with pytest.raises(ValueError):
        size_position(
            symbol=filters.symbol,
            side=Side.LONG,
            balance=balance,
            entry_price=entry_price,
            stop_price=Decimal("64000"),
            risk_fraction=Decimal("0.01"),
            filters=filters,
            leverage=leverage,
        )


def test_spot_leverage_one_has_no_liquidation_price():
    filters = BTCUSDT_SPOT_FILTERS
    result = size_position(
        symbol=filters.symbol,
        side=Side.LONG,
        balance=Decimal("100000"),
        entry_price=Decimal("65000.00"),
        stop_price=Decimal("64000.00"),
        risk_fraction=Decimal("0.01"),
        filters=filters,
        leverage=Decimal("1"),
    )
    assert result.approved is True
    assert result.liquidation_price is None
    assert result.required_margin == result.notional


LEVERAGES = [Decimal("2"), Decimal("5"), Decimal("10"), Decimal("20"), Decimal("25")]


@pytest.mark.parametrize("side", [Side.LONG, Side.SHORT])
def test_liquidation_price_on_correct_side_and_monotonic_in_leverage(side):
    filters = BTCUSDT_PERP_FILTERS
    entry = Decimal("65000.0")
    stop = Decimal("64000.0") if side is Side.LONG else Decimal("66000.0")

    distances: list[Decimal] = []
    for leverage in LEVERAGES:
        result = size_position(
            symbol=filters.symbol,
            side=side,
            balance=Decimal("1000000"),
            entry_price=entry,
            stop_price=stop,
            risk_fraction=Decimal("0.01"),
            filters=filters,
            leverage=leverage,
        )
        assert result.approved is True
        liq = result.liquidation_price
        assert liq is not None

        if side is Side.LONG:
            assert liq < entry
        else:
            assert liq > entry

        distances.append(abs(entry - liq))

    # Higher leverage -> liquidation price closer to entry (less room),
    # strictly monotonic across this leverage sweep.
    for earlier, later in itertools.pairwise(distances):
        assert later < earlier


def test_effective_leverage_and_required_margin_are_consistent():
    filters = BTCUSDT_PERP_FILTERS
    result = size_position(
        symbol=filters.symbol,
        side=Side.LONG,
        balance=Decimal("100000"),
        entry_price=Decimal("65000.0"),
        stop_price=Decimal("64000.0"),
        risk_fraction=Decimal("0.01"),
        filters=filters,
        leverage=Decimal("10"),
    )
    assert result.approved is True
    assert result.notional == result.quantity * result.entry_price
    assert result.required_margin == result.notional / Decimal("10")
    assert result.effective_leverage == result.notional / Decimal("100000")


# ---------------------------------------------------------------------------
# F3 — margin_type param + honest liquidation labeling
# ---------------------------------------------------------------------------


def _sized(margin_type: str, leverage: str = "10"):
    return size_position(
        symbol=BTCUSDT_PERP_FILTERS.symbol,
        side=Side.LONG,
        balance=Decimal("100000"),
        entry_price=Decimal("65000.0"),
        stop_price=Decimal("64000.0"),
        risk_fraction=Decimal("0.01"),
        filters=BTCUSDT_PERP_FILTERS,
        leverage=Decimal(leverage),
        margin_type=margin_type,
    )


def test_default_margin_type_is_isolated_label():
    result = size_position(
        symbol=BTCUSDT_PERP_FILTERS.symbol,
        side=Side.LONG,
        balance=Decimal("100000"),
        entry_price=Decimal("65000.0"),
        stop_price=Decimal("64000.0"),
        risk_fraction=Decimal("0.01"),
        filters=BTCUSDT_PERP_FILTERS,
        leverage=Decimal("10"),
    )
    assert result.liquidation_model == "isolated"


def test_isolated_and_cross_share_the_same_liquidation_price_but_differ_in_label():
    iso = _sized("ISOLATED")
    cross = _sized("CROSSED")
    # F3: cross keeps the isolated-equivalent (conservative) figure — same
    # arithmetic, different honesty label.
    assert iso.liquidation_price == cross.liquidation_price
    assert iso.liquidation_model == "isolated"
    assert cross.liquidation_model == "isolated_conservative_for_cross"


def test_cross_label_carries_through_rejected_results():
    # A below-min size (tiny balance) still reports the cross label honestly.
    result = size_position(
        symbol=BTCUSDT_PERP_FILTERS.symbol,
        side=Side.LONG,
        balance=Decimal("5"),
        entry_price=Decimal("65000.0"),
        stop_price=Decimal("64000.0"),
        risk_fraction=Decimal("0.01"),
        filters=BTCUSDT_PERP_FILTERS,
        leverage=Decimal("10"),
        margin_type="CROSSED",
    )
    assert result.approved is False
    assert result.liquidation_model == "isolated_conservative_for_cross"


@pytest.mark.parametrize("margin_type", ["ISOLATED", "CROSSED"])
def test_margin_type_never_changes_the_liquidation_arithmetic(margin_type):
    # The estimate is flat-MMR isolated regardless of margin mode this pass;
    # only the label moves.
    result = _sized(margin_type)
    inv_leverage = Decimal(1) / Decimal("10")
    expected = Decimal("65000.0") * (Decimal(1) - inv_leverage + Decimal("0.005"))
    assert result.liquidation_price == expected


def test_side_accepts_plain_string():
    filters = BTCUSDT_SPOT_FILTERS
    result = size_position(
        symbol=filters.symbol,
        side="long",
        balance=Decimal("10000"),
        entry_price=Decimal("65000.00"),
        stop_price=Decimal("64000.00"),
        risk_fraction=Decimal("0.01"),
        filters=filters,
    )
    assert result.side is Side.LONG
    assert result.approved is True


def test_caller_may_pass_plain_floats():
    filters = BTCUSDT_SPOT_FILTERS
    result = size_position(
        symbol=filters.symbol,
        side=Side.LONG,
        balance=10000.0,
        entry_price=65000.00,
        stop_price=64000.00,
        risk_fraction=0.01,
        filters=filters,
    )
    assert result.approved is True
    assert result.realized_risk_fraction <= Decimal("0.01")
