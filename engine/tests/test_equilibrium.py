"""Port of equilibrium.test.ts."""

import pytest

from smc.analysis import compute_pivots
from smc.equilibrium import classify_price, compute_dealing_range
from smc.strength import derive_swing_strength
from smc.structure import compute_market_structure
from smc.types import PivotKind, PivotPoint
from tests.dreimann import DREIMANN_TRADES, label_time, load_dreimann_fixture


def pivot(kind: PivotKind, price: float, time: int) -> PivotPoint:
    return PivotPoint(kind=kind, price=price, time=time)


class TestComputeDealingRange:
    def test_returns_none_while_no_swing_has_proven_strong(self) -> None:
        structure = compute_market_structure(
            [pivot("low", 100, 1), pivot("high", 110, 2), pivot("low", 105, 3)]
        )
        assert compute_dealing_range(structure) is None

    def test_anchors_at_the_most_recent_strong_low_spans_to_the_extreme_high(self) -> None:
        structure = compute_market_structure(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 105, 3),
                pivot("high", 120, 4),
                pivot("low", 112, 5),
                pivot("high", 130, 6),
            ]
        )
        range_ = compute_dealing_range(structure)
        assert range_ is not None
        assert range_.anchor == "low"
        assert range_.low.price == 112
        assert range_.high.price == 130
        assert range_.equilibrium == 121

    def test_anchors_at_the_most_recent_strong_high_in_a_downtrend(self) -> None:
        structure = compute_market_structure(
            [
                pivot("high", 130, 1),
                pivot("low", 120, 2),
                pivot("high", 125, 3),
                pivot("low", 110, 4),
                pivot("high", 115, 5),
                pivot("low", 100, 6),
            ]
        )
        range_ = compute_dealing_range(structure)
        assert range_ is not None
        assert range_.anchor == "high"
        assert range_.high.price == 115
        assert range_.low.price == 100
        assert range_.equilibrium == 107.5

    def test_spans_to_the_most_extreme_opposite_swing_not_the_nearest(self) -> None:
        structure = compute_market_structure(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 105, 3),
                pivot("high", 120, 4),
                pivot("low", 111, 5),
                pivot("high", 118, 6),
            ]
        )
        range_ = compute_dealing_range(structure)
        assert range_ is not None
        assert range_.low.price == 105
        assert range_.high.price == 120

    def test_stays_coherent_with_the_strength_view_it_derives_from(self) -> None:
        for name in DREIMANN_TRADES:
            fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
            for candles in fixture.series.values():
                structure = compute_market_structure(compute_pivots(candles))
                range_ = compute_dealing_range(structure)
                if range_ is None:
                    continue
                assert range_.low.price < range_.high.price
                assert range_.equilibrium == (range_.low.price + range_.high.price) / 2
                anchor_swing = range_.low if range_.anchor == "low" else range_.high
                entry = next(
                    (e for e in derive_swing_strength(structure) if e.swing is anchor_swing),
                    None,
                )
                assert entry is not None and entry.strength == "strong"


class TestClassifyPrice:
    def test_splits_the_range_at_its_exact_midpoint(self) -> None:
        structure = compute_market_structure(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 105, 3),
                pivot("high", 120, 4),
                pivot("low", 112, 5),
                pivot("high", 130, 6),
            ]
        )
        range_ = compute_dealing_range(structure)
        assert range_ is not None
        assert classify_price(range_, 125) == "premium"
        assert classify_price(range_, 118) == "discount"
        assert classify_price(range_, 121) == "equilibrium"


class TestDreimannAnnotationFidelityEquilibrium:
    # Logic correctness only; no threshold tuning against these fixtures (R5).

    @pytest.mark.parametrize("name", DREIMANN_TRADES)
    def test_an_active_4h_dealing_range_exists_as_of_entry(self, name: str) -> None:
        fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
        entry_time = label_time(fixture.labels.entry.approx_time_utc)
        context = [c for c in fixture.series["4h"] if c.time <= entry_time]
        assert compute_dealing_range(compute_market_structure(compute_pivots(context))) is not None

    @pytest.mark.parametrize(
        "name",
        [
            n
            for n in DREIMANN_TRADES
            if load_dreimann_fixture(n).labels.objective.claims_weak_structure  # type: ignore[arg-type]
        ],
    )
    def test_canonical_weak_structure_setup_was_bought_at_a_discount(self, name: str) -> None:
        fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
        entry_time = label_time(fixture.labels.entry.approx_time_utc)
        context = [c for c in fixture.series["4h"] if c.time <= entry_time]
        range_ = compute_dealing_range(compute_market_structure(compute_pivots(context)))
        assert range_ is not None
        assert classify_price(range_, fixture.labels.entry.price) == "discount"

    def test_jup_tp_premium_read_reproduces_the_traders_own_risk_note(self) -> None:
        fixture = load_dreimann_fixture("jup-tp")
        entry_time = label_time(fixture.labels.entry.approx_time_utc)
        context = [c for c in fixture.series["4h"] if c.time <= entry_time]
        range_ = compute_dealing_range(compute_market_structure(compute_pivots(context)))
        assert range_ is not None
        assert classify_price(range_, fixture.labels.entry.price) == "premium"

    def test_characterizes_the_observed_entry_positions_across_all_six_trades(self) -> None:
        # Regression pin of today's derivation, not ground truth.
        positions: dict[str, str] = {}
        for name in DREIMANN_TRADES:
            fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
            entry_time = label_time(fixture.labels.entry.approx_time_utc)
            context = [c for c in fixture.series["4h"] if c.time <= entry_time]
            range_ = compute_dealing_range(compute_market_structure(compute_pivots(context)))
            assert range_ is not None
            positions[name] = classify_price(range_, fixture.labels.entry.price)
        assert positions == {
            "zec-tp": "discount",
            "trx-tp3": "discount",
            "zec-sl": "discount",
            "ethfi-sl": "discount",
            "jup-tp": "premium",
            "fet-tp": "premium",
        }
