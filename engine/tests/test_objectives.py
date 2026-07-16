"""Port of objectives.test.ts."""

import pytest

from smc.analysis import compute_pivots
from smc.liquidity import (
    LiquidityPool,
    LiquidityPoolComponents,
    LiquiditySide,
    compute_liquidity_pools,
)
from smc.mock_candles import generate_mock_candles
from smc.objectives import resolve_objectives
from smc.structure import EqualLevel, compute_market_structure
from smc.types import PivotKind, PivotPoint
from tests.dreimann import DREIMANN_TRADES, label_time, load_dreimann_fixture


def pivot(kind: PivotKind, price: float, time: int) -> PivotPoint:
    return PivotPoint(kind=kind, price=price, time=time)


def fake_pool(side: LiquiditySide, price: float, intact: bool = True) -> LiquidityPool:
    """Minimal hand-built pool — the resolver reads only side, price, intact."""
    cluster = EqualLevel(kind="eqh" if side == "bsl" else "eql", price=price, swings=[])
    return LiquidityPool(
        side=side,
        price=price,
        cluster=cluster,
        intact=intact,
        confidence=50,
        tier="Moderate",
        components=LiquidityPoolComponents(touches=0.5, tightness=1, recency=1),
    )


# Uptrend with a completed pullback at the end: 130 settles weak, 128 is
# unresolved; both untaken. The earlier highs 110/120 were taken later.
UPTREND = compute_market_structure(
    [
        pivot("low", 100, 1),
        pivot("high", 110, 2),
        pivot("low", 105, 3),
        pivot("high", 120, 4),
        pivot("low", 112, 5),
        pivot("high", 130, 6),
        pivot("low", 122, 7),
        pivot("high", 128, 8),
    ]
)


class TestResolveObjectives:
    def test_ranks_untaken_weak_unresolved_highs_by_proximity_preferred_first(self) -> None:
        candidates = resolve_objectives(UPTREND, [], "long", 124)
        assert [c.price for c in candidates] == [128, 130]
        assert [c.strength for c in candidates] == ["unresolved", "weak"]
        assert candidates[0].swing.time == 8
        assert all(c.direction == "long" for c in candidates)
        for i in range(1, len(candidates)):
            assert candidates[i].price > candidates[i - 1].price

    def test_skips_taken_candidates(self) -> None:
        candidates = resolve_objectives(UPTREND, [], "long", 106)
        assert not any(c.swing.price == 110 for c in candidates)
        assert not any(c.swing.price == 120 for c in candidates)

    def test_mirrors_for_shorts(self) -> None:
        downtrend = compute_market_structure(
            [
                pivot("high", 130, 1),
                pivot("low", 120, 2),
                pivot("high", 125, 3),
                pivot("low", 110, 4),
                pivot("high", 118, 5),
                pivot("low", 102, 6),
                pivot("high", 108, 7),
                pivot("low", 104, 8),
            ]
        )
        candidates = resolve_objectives(downtrend, [], "short", 107)
        assert [c.price for c in candidates] == [104, 102]
        assert [c.strength for c in candidates] == ["unresolved", "weak"]
        assert all(c.direction == "short" for c in candidates)

    def test_excludes_strong_swings(self) -> None:
        downtrend = compute_market_structure(
            [
                pivot("high", 130, 1),
                pivot("low", 120, 2),
                pivot("high", 125, 3),
                pivot("low", 110, 4),
                pivot("high", 115, 5),
                pivot("low", 100, 6),
            ]
        )
        candidates = resolve_objectives(downtrend, [], "long", 101)
        assert all(c.strength != "strong" for c in candidates)
        assert not any(c.swing.price == 125 for c in candidates)
        assert not any(c.swing.price == 115 for c in candidates)

    def test_requires_the_candidate_strictly_beyond_from_price(self) -> None:
        assert resolve_objectives(UPTREND, [], "long", 130) == []
        assert [c.price for c in resolve_objectives(UPTREND, [], "long", 129.999)] == [130]

    def test_returns_empty_when_everything_above_is_strong_or_taken(self) -> None:
        grind = compute_market_structure(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 95, 3),  # breaks 100: 110 is strong
                pivot("high", 112, 4),
            ]
        )
        assert resolve_objectives(grind, [], "long", 112) == []


class TestPoolAffinity:
    # EQH cluster 110 / 109.95 (within tolerance): pool line = 110. Both
    # members settle weak and stay untaken.
    CLUSTER = compute_market_structure(
        [
            pivot("low", 100, 1),
            pivot("high", 110, 2),
            pivot("low", 105, 3),
            pivot("high", 109.95, 4),
            pivot("low", 106, 5),
            pivot("high", 108, 6),
        ]
    )

    def test_promotes_a_coinciding_candidates_price_to_the_pool_line_once(self) -> None:
        pools = compute_liquidity_pools(self.CLUSTER)
        candidates = resolve_objectives(self.CLUSTER, pools, "long", 106.5)
        assert [c.price for c in candidates] == [108, 110]
        assert candidates[0].pool is None
        assert candidates[1].pool is not None and candidates[1].pool.price == 110
        assert len([c for c in candidates if c.pool is not None]) == 1

    def test_uses_a_pool_line_sitting_between_the_candidate_and_from_price(self) -> None:
        between = fake_pool("bsl", 127)
        candidates = resolve_objectives(UPTREND, [between], "long", 124)
        assert candidates[0].price == 127
        assert candidates[0].pool is between
        assert candidates[0].swing.price == 128

    def test_ignores_spent_pools_and_pools_on_the_wrong_side(self) -> None:
        spent = fake_pool("bsl", 127, False)
        ssl = fake_pool("ssl", 127)
        candidates = resolve_objectives(UPTREND, [spent, ssl], "long", 124)
        assert [c.price for c in candidates] == [128, 130]
        assert all(c.pool is None for c in candidates)


class TestReplaySafety:
    def test_is_deterministic_over_identical_input(self) -> None:
        for symbol in ("BTC", "ETH", "SOL"):
            candles = generate_mock_candles(symbol, "1H", 300)
            structure = compute_market_structure(compute_pivots(candles))
            pools = compute_liquidity_pools(structure)
            from_ = candles[-1].close
            assert resolve_objectives(structure, pools, "long", from_) == resolve_objectives(
                structure, pools, "long", from_
            )

    def test_resolves_at_bar_k_from_bars_at_most_k_only(self) -> None:
        for symbol in ("BTC", "ETH"):
            candles = generate_mock_candles(symbol, "1H", 360)
            for n in range(60, len(candles) + 1, 20):
                window = candles[:n]
                structure = compute_market_structure(compute_pivots(window))
                pools = compute_liquidity_pools(structure)
                from_ = window[-1].close
                for direction in ("long", "short"):
                    candidates = resolve_objectives(structure, pools, direction, from_)
                    for c in candidates:
                        assert c.swing.time <= window[-1].time
                        assert c.price > from_ if direction == "long" else c.price < from_
                    for i in range(1, len(candidates)):
                        if direction == "long":
                            assert candidates[i].price > candidates[i - 1].price
                        else:
                            assert candidates[i].price < candidates[i - 1].price


class TestDreimannAnnotationFidelityObjectives:
    @pytest.mark.parametrize(
        "name",
        [
            n
            for n in DREIMANN_TRADES
            if load_dreimann_fixture(n).labels.objective.claims_weak_structure  # type: ignore[arg-type]
            and load_dreimann_fixture(n).labels.objective.within_window  # type: ignore[arg-type]
        ],
    )
    def test_preferred_objective_at_entry_is_the_traders_weak_structure_tp(self, name: str) -> None:
        fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
        labels = fixture.labels
        candles = fixture.series[labels.execution_timeframe]
        entry_time = label_time(labels.entry.approx_time_utc)
        structure = compute_market_structure(
            compute_pivots([c for c in candles if c.time <= entry_time])
        )
        pools = compute_liquidity_pools(structure)
        candidates = resolve_objectives(structure, pools, "long", labels.entry.price)

        assert candidates
        preferred = candidates[0]
        tolerance = labels.objective.tolerance_pct / 100
        assert abs(preferred.price - labels.objective.price) / labels.objective.price <= tolerance
        assert preferred.strength != "strong"

    def test_zec_tp_recorded_divergence_no_candidate_at_the_487_tp(self) -> None:
        # trades.txt makes no weak-structure claim for this trade and the
        # engine reads the 487-area high strong as-of entry. EDR 0008.
        fixture = load_dreimann_fixture("zec-tp")
        labels = fixture.labels
        candles = fixture.series[labels.execution_timeframe]
        entry_time = label_time(labels.entry.approx_time_utc)
        structure = compute_market_structure(
            compute_pivots([c for c in candles if c.time <= entry_time])
        )
        pools = compute_liquidity_pools(structure)
        candidates = resolve_objectives(structure, pools, "long", labels.entry.price)
        tolerance = labels.objective.tolerance_pct / 100
        at_label = [
            c
            for c in candidates
            if abs(c.price - labels.objective.price) / labels.objective.price <= tolerance
        ]
        assert at_label == []
