"""Port of strength.test.ts."""

import pytest

from smc.analysis import compute_pivots, pivot_window
from smc.mock_candles import generate_mock_candles
from smc.strength import derive_swing_strength
from smc.structure import compute_market_structure
from smc.types import PivotKind, PivotPoint
from tests.dreimann import DREIMANN_TRADES, label_time, load_dreimann_fixture


def pivot(kind: PivotKind, price: float, time: int) -> PivotPoint:
    return PivotPoint(kind=kind, price=price, time=time)


def strengths(pivots: list[PivotPoint]) -> list[str]:
    return [e.strength for e in derive_swing_strength(compute_market_structure(pivots))]


class TestDeriveSwingStrength:
    def test_returns_one_entry_per_swing_joined_by_identity_in_order(self) -> None:
        structure = compute_market_structure(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 105, 3),
                pivot("high", 120, 4),
            ]
        )
        entries = derive_swing_strength(structure)
        assert len(entries) == len(structure.swings)
        for i, entry in enumerate(entries):
            assert entry.swing is structure.swings[i]

    def test_marks_a_high_strong_the_moment_its_pullback_breaks_the_prior_low(self) -> None:
        structure = compute_market_structure(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 90, 3),  # still-forming counter-leg already below 100
            ]
        )
        entries = derive_swing_strength(structure)
        assert entries[1].strength == "strong"
        assert entries[1].judged_by is structure.swings[2]

    def test_marks_a_high_weak_only_once_its_failed_counter_leg_completes(self) -> None:
        forming = strengths([pivot("low", 100, 1), pivot("high", 110, 2), pivot("low", 105, 3)])
        # Counter-leg holds above 100 but could still extend down: unresolved.
        assert forming[1] == "unresolved"

        completed = strengths(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 105, 3),
                pivot("high", 108, 4),  # next high freezes the leg at 105 — the push failed
            ]
        )
        assert completed[1] == "weak"

    def test_reads_an_uptrend_as_weak_highs_over_strong_lows(self) -> None:
        entries = strengths(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 105, 3),
                pivot("high", 120, 4),
                pivot("low", 112, 5),
                pivot("high", 130, 6),
            ]
        )
        assert entries == ["unresolved", "weak", "strong", "weak", "strong", "unresolved"]

    def test_reads_a_downtrend_as_strong_highs_over_weak_lows(self) -> None:
        entries = strengths(
            [
                pivot("high", 130, 1),
                pivot("low", 120, 2),
                pivot("high", 125, 3),
                pivot("low", 110, 4),
                pivot("high", 115, 5),
                pivot("low", 100, 6),
            ]
        )
        assert entries == ["unresolved", "weak", "strong", "weak", "strong", "unresolved"]

    def test_does_not_count_an_equal_level_retest_as_a_break(self) -> None:
        entries = strengths(
            [
                pivot("low", 100, 1),
                pivot("high", 110, 2),
                pivot("low", 100, 3),
                pivot("high", 104, 4),
            ]
        )
        assert entries[1] == "weak"

    def test_never_settles_the_last_two_swings_weak(self) -> None:
        for symbol in ("BTC", "ETH", "SOL"):
            candles = generate_mock_candles(symbol, "1H", 300)
            entries = derive_swing_strength(compute_market_structure(compute_pivots(candles)))
            for entry in entries[-2:]:
                assert entry.strength != "weak"
            last = entries[-1]
            assert last.strength == "unresolved"
            assert last.judged_by is None

    def test_is_append_only_under_growing_windows_with_stable_pivot_substrate(self) -> None:
        # Within a span where pivot_window(n) is constant, a resolved strength
        # must never change: a break cannot un-happen and a completed failed
        # leg cannot retroactively succeed.
        for symbol in ("BTC", "ETH", "SOL", "DOGE"):
            candles = generate_mock_candles(symbol, "1H", 480)
            current_k = -1
            seen: dict[str, str] = {}
            resolutions = 0
            for n in range(60, len(candles) + 1):
                k = pivot_window(n)
                if k != current_k:
                    current_k = k
                    seen = {}
                entries = derive_swing_strength(
                    compute_market_structure(compute_pivots(candles[:n]))
                )
                for entry in entries:
                    key = f"{entry.swing.time}:{entry.swing.kind}"
                    previous = seen.get(key)
                    if previous is not None and previous != "unresolved":
                        assert entry.strength == previous, f"{key} {previous}->{entry.strength}"
                    if entry.strength != "unresolved":
                        resolutions += 1
                    seen[key] = entry.strength
            assert resolutions > 100


class TestDreimannAnnotationFidelityStrength:
    # Logic correctness only: do we type the swings the trader drew the way the
    # trader read them? Never tune a threshold against these (R5).

    @pytest.mark.parametrize("name", DREIMANN_TRADES)
    def test_a_strong_low_protects_below_the_entry_on_the_4h_context(self, name: str) -> None:
        # Every example trade is a pullback long riding defended structure, so
        # the low that launched the HTF leg must read strong at decision time.
        fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
        entry_time = label_time(fixture.labels.entry.approx_time_utc)
        context = [c for c in fixture.series["4h"] if c.time <= entry_time]
        entries = derive_swing_strength(compute_market_structure(compute_pivots(context)))
        protected_lows = [
            e
            for e in entries
            if e.swing.kind == "low"
            and e.strength == "strong"
            and e.swing.price < fixture.labels.entry.price
        ]
        assert len(protected_lows) > 0

    @pytest.mark.parametrize(
        "name",
        [
            n
            for n in DREIMANN_TRADES
            if load_dreimann_fixture(n).labels.objective.claims_weak_structure  # type: ignore[arg-type]
        ],
    )
    def test_claimed_weak_structure_objective_is_targetable_and_settles_weak(
        self, name: str
    ) -> None:
        fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
        labels = fixture.labels
        candles = fixture.series[labels.execution_timeframe]
        entry_time = label_time(labels.entry.approx_time_utc)
        tolerance = labels.objective.tolerance_pct / 100

        def matches_objective(price: float) -> bool:
            return abs(price - labels.objective.price) / labels.objective.price <= tolerance

        # As-of the entry bar: at least one pre-entry swing high at the
        # objective level must read weak or unresolved — targetable.
        at_entry = derive_swing_strength(
            compute_market_structure(compute_pivots([c for c in candles if c.time <= entry_time]))
        )
        targetable = [
            e
            for e in at_entry
            if e.swing.kind == "high"
            and e.swing.time < entry_time
            and matches_objective(e.swing.price)
            and e.strength != "strong"
        ]
        assert len(targetable) > 0

        # On the full window: at least one objective-level high that price
        # actually took out afterwards settles weak.
        max_after_entry = max(c.high for c in candles if c.time > entry_time)
        full = derive_swing_strength(compute_market_structure(compute_pivots(candles)))
        settled_weak = [
            e
            for e in full
            if e.swing.kind == "high"
            and e.swing.time < entry_time
            and matches_objective(e.swing.price)
            and e.swing.price <= max_after_entry
            and e.strength == "weak"
        ]
        assert len(settled_weak) > 0

    def test_zec_sl_dotted_h4_objective_is_the_jul_4_swing_high(self) -> None:
        # The sharpest single annotation in the set: the chart's dotted
        # weak-structure line at ~476.9 is one specific 4h swing.
        fixture = load_dreimann_fixture("zec-sl")
        candles = fixture.series["4h"]
        entry_time = label_time(fixture.labels.entry.approx_time_utc)

        at_entry = derive_swing_strength(
            compute_market_structure(compute_pivots([c for c in candles if c.time <= entry_time]))
        )
        objective_at_entry = next(
            (e for e in at_entry if e.swing.kind == "high" and abs(e.swing.price - 476.74) < 0.01),
            None,
        )
        assert objective_at_entry is not None
        assert objective_at_entry.strength == "unresolved"

        full = derive_swing_strength(compute_market_structure(compute_pivots(candles)))
        objective_full = next(
            (e for e in full if e.swing.kind == "high" and abs(e.swing.price - 476.74) < 0.01),
            None,
        )
        assert objective_full is not None
        assert objective_full.strength == "weak"
