"""Port of liquidity.test.ts.

The evaluate_signal exposure tests land with quant.py's port.
"""

import math

from smc.liquidity import (
    LIQUIDITY_WEIGHTS,
    LiquidityPool,
    compute_liquidity_pools,
    detect_liquidity_sweeps,
)
from smc.structure import compute_market_structure
from smc.types import Candle, PivotKind, PivotPoint

Step = tuple[PivotKind, float]


def pivots(*steps: Step) -> list[PivotPoint]:
    return [PivotPoint(time=i + 1, price=price, kind=kind) for i, (kind, price) in enumerate(steps)]


def pools_for(*steps: Step) -> list[LiquidityPool]:
    return compute_liquidity_pools(compute_market_structure(pivots(*steps)))


class TestComputeLiquidityPools:
    def test_derives_a_bsl_pool_from_an_equal_high_cluster_at_the_extreme(self) -> None:
        pools = pools_for(("high", 100), ("low", 50), ("high", 100.05), ("low", 55))
        assert len(pools) == 1
        assert pools[0].side == "bsl"
        # The liquidity line is the highest of the equal highs — where buy stops rest.
        assert pools[0].price == 100.05
        assert pools[0].cluster.kind == "eqh"
        assert pools[0].intact is True

    def test_derives_an_ssl_pool_from_an_equal_low_cluster_at_the_extreme(self) -> None:
        pools = pools_for(("low", 100), ("high", 150), ("low", 99.95), ("high", 140))
        assert len(pools) == 1
        assert pools[0].side == "ssl"
        assert pools[0].price == 99.95
        assert pools[0].cluster.kind == "eql"
        assert pools[0].intact is True

    def test_returns_no_pools_when_the_structure_has_no_equal_clusters(self) -> None:
        assert pools_for(("low", 10), ("high", 20), ("low", 12), ("high", 24)) == []
        assert compute_liquidity_pools(compute_market_structure([])) == []

    # --- Confidence components -----------------------------------------------

    def test_scores_more_touches_higher(self) -> None:
        double = pools_for(("high", 100), ("low", 50), ("high", 100), ("low", 55))
        triple = pools_for(
            ("high", 100), ("low", 50), ("high", 100), ("low", 55), ("high", 100), ("low", 52)
        )
        quad = pools_for(
            ("high", 100),
            ("low", 50),
            ("high", 100),
            ("low", 55),
            ("high", 100),
            ("low", 52),
            ("high", 100),
            ("low", 53),
        )
        assert double[0].components.touches == 0.5
        assert math.isclose(triple[0].components.touches, 0.85, abs_tol=1e-10)
        assert quad[0].components.touches == 1

    def test_scores_tick_identical_clusters_maximally_tight(self) -> None:
        exact = pools_for(("high", 100), ("low", 50), ("high", 100), ("low", 55))
        # 100 -> 100.1 spans the full one-sided tolerance (0.1%), half the
        # theoretical +/- tolerance span, so tightness reads 0.5.
        spread = pools_for(("high", 100), ("low", 50), ("high", 100.1), ("low", 55))
        assert exact[0].components.tightness == 1
        assert math.isclose(spread[0].components.tightness, 0.5, abs_tol=1e-10)
        assert exact[0].confidence > spread[0].confidence

    def test_decays_confidence_as_the_pool_ages_behind_newer_swings(self) -> None:
        cluster: list[Step] = [("high", 100), ("low", 50), ("high", 100), ("low", 55)]
        aged: list[Step] = [*cluster, ("high", 90), ("low", 52), ("high", 88), ("low", 51)]
        fresh = pools_for(*cluster)[0]
        old = pools_for(*aged)[0]
        assert old.components.recency < fresh.components.recency
        assert old.confidence < fresh.confidence
        assert old.intact is True

    def test_confidence_is_exactly_the_documented_weighted_blend(self) -> None:
        pools = pools_for(
            ("high", 100), ("low", 50), ("high", 100.05), ("low", 55), ("high", 92), ("low", 53)
        )
        for pool in pools:
            expected = math.floor(
                100
                * (
                    LIQUIDITY_WEIGHTS["touches"] * pool.components.touches
                    + LIQUIDITY_WEIGHTS["tightness"] * pool.components.tightness
                    + LIQUIDITY_WEIGHTS["recency"] * pool.components.recency
                )
                + 0.5
            )
            assert pool.confidence == expected
            assert 0 <= pool.confidence <= 100

    # --- Intact vs spent -------------------------------------------------------

    def test_marks_a_bsl_pool_spent_once_a_later_swing_high_trades_above(self) -> None:
        pools = pools_for(
            ("high", 100), ("low", 50), ("high", 100), ("low", 55), ("high", 104), ("low", 60)
        )
        bsl = next(p for p in pools if p.side == "bsl")
        assert bsl.intact is False

    def test_marks_an_ssl_pool_spent_once_a_later_swing_low_trades_below(self) -> None:
        pools = pools_for(
            ("low", 100), ("high", 150), ("low", 100), ("high", 140), ("low", 96), ("high", 130)
        )
        ssl = next(p for p in pools if p.side == "ssl")
        assert ssl.intact is False

    def test_keeps_a_pool_intact_while_later_swings_stay_on_the_near_side(self) -> None:
        pools = pools_for(
            ("high", 100), ("low", 50), ("high", 100), ("low", 55), ("high", 99), ("low", 58)
        )
        assert next(p for p in pools if p.side == "bsl").intact is True

    # --- Determinism and replay safety ------------------------------------------

    def test_is_deterministic(self) -> None:
        seq: list[Step] = [
            ("high", 100),
            ("low", 50),
            ("high", 100.05),
            ("low", 50.02),
            ("high", 108),
            ("low", 60),
        ]
        assert pools_for(*seq) == pools_for(*seq)

    def test_is_replay_safe_intact_at_every_prefix_before_the_run(self) -> None:
        seq: list[Step] = [
            ("high", 100),
            ("low", 50),
            ("high", 100),  # cluster completes: pool exists from here
            ("low", 55),
            ("high", 104),  # the swing that runs the stops
            ("low", 60),
        ]
        for k in range(3, len(seq) + 1):
            pools = pools_for(*seq[:k])
            bsl = next((p for p in pools if p.side == "bsl"), None)
            assert bsl is not None
            assert bsl.intact is (k < 5)
            assert [s.price for s in bsl.cluster.swings] == [100, 100]

    # --- Ordering ---------------------------------------------------------------

    def test_returns_pools_strongest_first(self) -> None:
        pools = pools_for(
            ("high", 100),
            ("low", 50),
            ("high", 100),  # double top, old
            ("low", 50.01),  # double bottom forms below
            ("high", 92),
            ("low", 50.02),  # triple bottom — more touches, fresher
            ("high", 90),
        )
        assert len(pools) >= 2
        for i in range(1, len(pools)):
            assert pools[i].confidence <= pools[i - 1].confidence


def candle(time: int, high: float, low: float, close: float) -> Candle:
    return Candle(time=time, open=close, high=high, low=low, close=close, volume=1000)


def bsl_pools() -> list[LiquidityPool]:
    # A BSL pool at 100: equal highs at pivot times 1 and 3 (the completing
    # touch is t=3), lows between. Candles carry later times.
    return pools_for(("high", 100), ("low", 50), ("high", 100), ("low", 55))


def ssl_pools() -> list[LiquidityPool]:
    return pools_for(("low", 100), ("high", 150), ("low", 100), ("high", 140))


class TestDetectLiquiditySweeps:
    def test_detects_a_buy_side_sweep(self) -> None:
        sweeps = detect_liquidity_sweeps(
            bsl_pools(),
            [candle(10, 99, 95, 98), candle(11, 100.5, 97, 99.2), candle(12, 99, 96, 97)],
        )
        assert len(sweeps) == 1
        assert sweeps[0].side == "bsl"
        assert sweeps[0].time == 11
        assert sweeps[0].extreme == 100.5
        assert sweeps[0].close == 99.2
        assert math.isclose(sweeps[0].penetration, 0.005, abs_tol=1e-10)
        assert sweeps[0].pool.price == 100

    def test_detects_a_sell_side_sweep(self) -> None:
        sweeps = detect_liquidity_sweeps(
            ssl_pools(), [candle(10, 105, 101, 102), candle(11, 103, 99.4, 100.8)]
        )
        assert len(sweeps) == 1
        assert sweeps[0].side == "ssl"
        assert sweeps[0].extreme == 99.4
        assert sweeps[0].close == 100.8

    def test_classifies_a_close_beyond_the_level_as_breakout_not_sweep(self) -> None:
        sweeps = detect_liquidity_sweeps(
            bsl_pools(), [candle(10, 100.5, 98, 100.4), candle(11, 101, 97, 98)]
        )
        assert sweeps == []

    def test_emits_at_most_one_sweep_per_pool_first_penetration_decides(self) -> None:
        sweeps = detect_liquidity_sweeps(
            bsl_pools(), [candle(10, 100.3, 97, 99), candle(11, 100.8, 96, 98)]
        )
        assert len(sweeps) == 1
        assert sweeps[0].time == 10

    def test_does_not_read_an_exact_touch_as_penetration(self) -> None:
        assert detect_liquidity_sweeps(bsl_pools(), [candle(10, 100, 97, 99)]) == []

    def test_ignores_candles_at_or_before_the_pools_completing_touch(self) -> None:
        sweeps = detect_liquidity_sweeps(
            bsl_pools(), [candle(2, 100.6, 95, 96), candle(3, 100.4, 95, 97)]
        )
        assert sweeps == []

    def test_reports_a_sweep_even_while_swing_bookkeeping_calls_the_pool_intact(self) -> None:
        pools = bsl_pools()
        sweeps = detect_liquidity_sweeps(pools, [candle(10, 100.5, 97, 99)])
        assert pools[0].intact is True
        assert len(sweeps) == 1

    def test_returns_no_sweeps_while_price_never_reaches_the_pool(self) -> None:
        assert detect_liquidity_sweeps(bsl_pools(), [candle(10, 99, 95, 98)]) == []
        assert detect_liquidity_sweeps([], [candle(10, 200, 1, 100)]) == []

    def test_detects_sweeps_on_both_sides_and_orders_events_by_time(self) -> None:
        pools = pools_for(("high", 100), ("low", 90), ("high", 100), ("low", 90), ("high", 96))
        sweeps = detect_liquidity_sweeps(
            pools, [candle(10, 97, 89.5, 91), candle(11, 100.4, 95, 98)]
        )
        assert [(s.side, s.time) for s in sweeps] == [("ssl", 10), ("bsl", 11)]

    def test_is_deterministic(self) -> None:
        candles = [candle(10, 100.5, 97, 99), candle(11, 98, 94, 95)]
        assert detect_liquidity_sweeps(bsl_pools(), candles) == detect_liquidity_sweeps(
            bsl_pools(), candles
        )

    def test_is_replay_safe_sweeps_are_append_only(self) -> None:
        candles = [
            candle(10, 99, 95, 98),
            candle(11, 100.5, 97, 99.2),  # the sweep candle
            candle(12, 99, 96, 97),
            candle(13, 100.8, 95, 96),  # later penetration of already-spent stops
        ]
        previous = 0
        for k in range(1, len(candles) + 1):
            sweeps = detect_liquidity_sweeps(bsl_pools(), candles[:k])
            assert len(sweeps) >= previous
            assert len(sweeps) == (1 if k >= 2 else 0)
            if sweeps:
                assert sweeps[0].time == 11
            previous = len(sweeps)
