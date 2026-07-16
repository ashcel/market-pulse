"""Port of structure.test.ts."""

from smc.analysis import compute_pivots
from smc.mock_candles import generate_mock_candles
from smc.structure import SwingPoint, compute_market_structure, to_alternating_swings
from smc.types import PivotKind, PivotPoint

Step = tuple[PivotKind, float]


def pivots(*steps: Step) -> list[PivotPoint]:
    """Pivot sequence from (kind, price) pairs with monotonic times."""
    return [PivotPoint(time=i + 1, price=price, kind=kind) for i, (kind, price) in enumerate(steps)]


class TestComputeMarketStructure:
    def test_labels_an_uptrend_as_higher_highs_and_higher_lows(self) -> None:
        s = compute_market_structure(
            pivots(("low", 10), ("high", 20), ("low", 12), ("high", 24), ("low", 15))
        )
        assert s.last_high is not None and s.last_high.label == "HH"
        assert s.last_low is not None and s.last_low.label == "HL"
        assert s.trend == "uptrend"

    def test_labels_a_downtrend_as_lower_highs_and_lower_lows(self) -> None:
        s = compute_market_structure(
            pivots(("high", 30), ("low", 20), ("high", 26), ("low", 15), ("high", 22))
        )
        assert s.last_low is not None and s.last_low.label == "LL"
        assert s.last_high is not None and s.last_high.label == "LH"
        assert s.trend == "downtrend"

    def test_reads_mixed_swings_hh_plus_ll_as_range(self) -> None:
        s = compute_market_structure(pivots(("low", 10), ("high", 20), ("low", 8), ("high", 25)))
        assert s.last_high is not None and s.last_high.label == "HH"
        assert s.last_low is not None and s.last_low.label == "LL"
        assert s.trend == "range"

    def test_leaves_the_first_high_and_first_low_unlabeled(self) -> None:
        s = compute_market_structure(pivots(("high", 20), ("low", 10)))
        assert s.swings[0].label is None
        assert s.swings[1].label is None
        assert s.trend == "range"

    def test_marks_a_break_that_extends_the_trend_as_bos(self) -> None:
        s = compute_market_structure(
            pivots(("low", 10), ("high", 20), ("low", 12), ("high", 24), ("low", 15), ("high", 30))
        )
        assert s.event == "bos"
        assert s.event_swing is not None and s.event_swing.label == "HH"

    def test_marks_a_break_against_the_trend_as_choch(self) -> None:
        s = compute_market_structure(
            pivots(("low", 10), ("high", 20), ("low", 12), ("high", 24), ("low", 8))
        )
        assert s.event == "choch"
        assert s.event_swing is not None and s.event_swing.label == "LL"
        assert s.trend != "uptrend"

    def test_returns_an_empty_neutral_structure_for_no_pivots(self) -> None:
        s = compute_market_structure([])
        assert s.swings == []
        assert s.trend == "range"
        assert s.last_high is None
        assert s.last_low is None
        assert s.event is None

    # --- Tie-break: an equal level fails to extend the extreme ---------------

    def test_labels_equal_high_as_lh_and_equal_low_as_hl(self) -> None:
        equal_high = compute_market_structure(pivots(("high", 100), ("low", 50), ("high", 100)))
        assert equal_high.last_high is not None and equal_high.last_high.label == "LH"

        equal_low = compute_market_structure(pivots(("low", 100), ("high", 150), ("low", 100)))
        assert equal_low.last_low is not None and equal_low.last_low.label == "HL"

    def test_reads_a_flat_range_as_range_not_downtrend(self) -> None:
        s = compute_market_structure(pivots(("high", 100), ("low", 90), ("high", 100), ("low", 90)))
        assert s.last_high is not None and s.last_high.label == "LH"
        assert s.last_low is not None and s.last_low.label == "HL"
        assert s.trend == "range"
        assert s.event is None

    # --- Event emission: structure forming vs. breaking -----------------------

    def test_emits_no_event_for_the_first_break_that_only_forms_a_trend(self) -> None:
        s = compute_market_structure(pivots(("low", 10), ("high", 20), ("low", 12), ("high", 24)))
        assert s.trend == "uptrend"
        assert s.event is None
        assert all(sw.event is None for sw in s.swings)

    def test_emits_no_event_for_an_only_highs_or_only_lows_series(self) -> None:
        only_highs = compute_market_structure(pivots(("high", 10), ("high", 20), ("high", 15)))
        assert only_highs.last_low is None
        assert only_highs.trend == "range"
        assert only_highs.event is None

        only_lows = compute_market_structure(pivots(("low", 20), ("low", 10), ("low", 15)))
        assert only_lows.last_high is None
        assert only_lows.trend == "range"
        assert only_lows.event is None

    def test_retains_each_break_on_its_own_swing_latest_as_event(self) -> None:
        s = compute_market_structure(
            pivots(
                ("low", 10),
                ("high", 20),
                ("low", 12),
                ("high", 24),
                ("low", 15),
                ("high", 30),
                ("low", 8),
            )
        )
        assert [sw.event for sw in s.swings] == [None, None, None, None, None, "bos", "choch"]
        assert s.event == "choch"
        assert s.event_swing is not None and s.event_swing.event == "choch"
        assert s.event_swing is s.swings[6]

    # --- Classification runs on alternating legs, not raw adjacency ----------

    def test_does_not_fabricate_a_label_from_a_lower_pivot_inside_the_same_leg(self) -> None:
        s = compute_market_structure(
            pivots(("high", 10), ("low", 5), ("high", 30), ("high", 25), ("low", 3))
        )
        assert [(w.kind, w.price, w.label) for w in s.swings] == [
            ("high", 10, None),
            ("low", 5, None),
            ("high", 30, "HH"),
            ("low", 3, "LL"),
        ]
        assert s.last_high is not None and s.last_high.label == "HH"

    def test_keeps_swings_strictly_alternating_for_real_confirmed_pivots(self) -> None:
        s = compute_market_structure(compute_pivots(generate_mock_candles("DOGE", "1H", 500)))
        assert len(s.swings) > 1
        for i in range(1, len(s.swings)):
            assert s.swings[i].kind != s.swings[i - 1].kind

    # --- Replay safety: a prefix reproduces the live prefix exactly ----------

    def test_produces_prefix_identical_swings(self) -> None:
        seq: list[Step] = [
            ("low", 10),
            ("high", 20),
            ("low", 12),
            ("high", 24),
            ("low", 15),
            ("high", 30),
            ("low", 8),
            ("high", 18),
        ]
        full = compute_market_structure(pivots(*seq))
        for k in range(1, len(seq) + 1):
            prefix = compute_market_structure(pivots(*seq[:k]))
            assert prefix.swings == full.swings[:k]


class TestEqualHighsEqualLows:
    def test_detects_exact_equal_highs_flagging_only_the_later_swing(self) -> None:
        s = compute_market_structure(pivots(("high", 100), ("low", 50), ("high", 100)))
        assert [sw.equal for sw in s.swings] == [None, None, "eqh"]
        assert len(s.equal_highs) == 1
        assert s.equal_highs[0].kind == "eqh"
        assert s.equal_highs[0].price == 100
        assert len(s.equal_highs[0].swings) == 2
        assert len(s.equal_lows) == 0
        assert s.swings[2].label == "LH"

    def test_detects_exact_equal_lows_flagging_only_the_later_swing(self) -> None:
        s = compute_market_structure(pivots(("low", 100), ("high", 150), ("low", 100)))
        assert [sw.equal for sw in s.swings] == [None, None, "eql"]
        assert len(s.equal_lows) == 1
        assert s.equal_lows[0].kind == "eql"
        assert s.equal_lows[0].price == 100
        assert len(s.equal_highs) == 0
        assert s.swings[2].label == "HL"

    def test_marginal_break_inside_tolerance_is_eqh_even_though_label_is_hh(self) -> None:
        s = compute_market_structure(pivots(("high", 100), ("low", 50), ("high", 100.1)))
        assert s.swings[2].label == "HH"
        assert s.swings[2].equal == "eqh"
        assert s.equal_highs[0].price == 100.1

    def test_does_not_read_a_swing_just_outside_tolerance_as_equal(self) -> None:
        s = compute_market_structure(pivots(("high", 100), ("low", 50), ("high", 100.2)))
        assert s.swings[2].equal is None
        assert len(s.equal_highs) == 0

    def test_measures_a_chain_against_the_cluster_anchor_no_drift(self) -> None:
        s = compute_market_structure(
            pivots(
                ("high", 100),
                ("low", 50),
                ("high", 100.09),
                ("low", 51),
                ("high", 100.19),
                ("low", 52),
            )
        )
        highs = [sw for sw in s.swings if sw.kind == "high"]
        assert [sw.equal for sw in highs] == [None, "eqh", None]
        assert len(s.equal_highs) == 1
        assert [sw.price for sw in s.equal_highs[0].swings] == [100, 100.09]
        assert s.equal_highs[0].price == 100.09

    def test_honors_a_custom_tolerance_including_zero(self) -> None:
        seq = pivots(("high", 100), ("low", 50), ("high", 100.1))
        assert len(compute_market_structure(seq, 0).equal_highs) == 0
        assert len(compute_market_structure(seq, 0.01).equal_highs) == 1

    def test_collects_triple_tops_and_closes_the_cluster_on_break(self) -> None:
        s = compute_market_structure(
            pivots(
                ("high", 100),
                ("low", 50),
                ("high", 100.05),
                ("low", 51),
                ("high", 99.95),
                ("low", 52),
                ("high", 110),
            )
        )
        assert len(s.equal_highs) == 1
        assert len(s.equal_highs[0].swings) == 3
        assert s.equal_highs[0].price == 100.05
        assert s.swings[-1].equal is None

    def test_never_reads_a_same_leg_pivot_shelf_as_equal_highs(self) -> None:
        s = compute_market_structure(pivots(("low", 50), ("high", 100), ("high", 100)))
        assert len(s.equal_highs) == 0
        assert len([sw for sw in s.swings if sw.kind == "high"]) == 1

    def test_leaves_labels_trend_and_events_untouched_by_equality(self) -> None:
        above = compute_market_structure(
            pivots(
                ("low", 10), ("high", 20), ("low", 12), ("high", 24), ("low", 15), ("high", 24.01)
            )
        )
        assert above.trend == "uptrend"
        assert [sw.label for sw in above.swings] == [None, None, "HL", "HH", "HL", "HH"]
        assert [sw.event for sw in above.swings] == [None, None, None, None, None, "bos"]
        assert above.swings[5].equal == "eqh"

        below = compute_market_structure(
            pivots(
                ("low", 10), ("high", 20), ("low", 12), ("high", 24), ("low", 15), ("high", 23.99)
            )
        )
        assert below.trend == "range"
        assert [sw.label for sw in below.swings] == [None, None, "HL", "HH", "HL", "LH"]
        assert all(sw.event is None for sw in below.swings)
        assert below.swings[5].equal == "eqh"

    def test_is_deterministic(self) -> None:
        seq: list[Step] = [
            ("high", 100),
            ("low", 50),
            ("high", 100.05),
            ("low", 50.02),
            ("high", 108),
            ("low", 60),
        ]
        assert compute_market_structure(pivots(*seq)) == compute_market_structure(pivots(*seq))

    def test_prefix_identical_equal_flags_and_stable_cluster_membership(self) -> None:
        seq: list[Step] = [
            ("high", 100),
            ("low", 50),
            ("high", 100.05),
            ("low", 50.02),
            ("high", 99.96),
            ("low", 58),
            ("high", 110),
            ("low", 70),
        ]
        full = compute_market_structure(pivots(*seq))
        for k in range(1, len(seq) + 1):
            prefix = compute_market_structure(pivots(*seq[:k]))
            assert prefix.swings == full.swings[:k]
            for i, cluster in enumerate(prefix.equal_highs):
                assert full.equal_highs[i].swings[: len(cluster.swings)] == cluster.swings
            for i, cluster in enumerate(prefix.equal_lows):
                assert full.equal_lows[i].swings[: len(cluster.swings)] == cluster.swings


class TestToAlternatingSwings:
    def test_collapses_runs_to_their_extremes(self) -> None:
        legs = to_alternating_swings(
            pivots(("low", 10), ("high", 20), ("high", 25), ("high", 22), ("low", 12))
        )
        assert [(leg.kind, leg.price) for leg in legs] == [("low", 10), ("high", 25), ("low", 12)]

    def test_keeps_the_lowest_of_consecutive_lows(self) -> None:
        legs = to_alternating_swings(
            pivots(("high", 30), ("low", 20), ("low", 15), ("low", 18), ("high", 25))
        )
        assert [(leg.kind, leg.price) for leg in legs] == [("high", 30), ("low", 15), ("high", 25)]

    def test_breaks_ties_toward_the_earlier_pivot_in_a_run(self) -> None:
        legs = to_alternating_swings(pivots(("low", 10), ("high", 20), ("high", 20)))
        assert len(legs) == 2
        assert legs[1].time == 2

    def test_emits_strictly_alternating_sequence_from_runs_on_both_sides(self) -> None:
        legs = to_alternating_swings(
            pivots(
                ("high", 5),
                ("high", 8),
                ("high", 6),
                ("low", 3),
                ("low", 1),
                ("high", 9),
                ("low", 2),
                ("low", 4),
            )
        )
        for i in range(1, len(legs)):
            assert legs[i].kind != legs[i - 1].kind
        assert [(leg.kind, leg.price) for leg in legs] == [
            ("high", 8),
            ("low", 1),
            ("high", 9),
            ("low", 2),
        ]

    def test_returns_an_empty_sequence_for_no_pivots(self) -> None:
        assert to_alternating_swings([]) == []


def test_swingpoint_equality_is_structural() -> None:
    a = SwingPoint(time=1, price=10, kind="high", label="HH", event=None, equal=None)
    b = SwingPoint(time=1, price=10, kind="high", label="HH", event=None, equal=None)
    assert a == b
