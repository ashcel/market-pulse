"""Port of trend-transition.test.ts."""

from dataclasses import replace

from smc.analysis import compute_pivots
from smc.mock_candles import generate_mock_candles
from smc.structure import compute_market_structure
from smc.trend_transition import TrendTransition, derive_trend_transitions, latest_transition
from smc.types import Candle, PivotKind, PivotPoint
from tests.dreimann import DREIMANN_TRADES, label_time, load_dreimann_fixture


def pivot(kind: PivotKind, price: float, time: int) -> PivotPoint:
    return PivotPoint(kind=kind, price=price, time=time)


# Downtrend: LH 90 / LL 40 after the opening 100/50 pair.
DOWNTREND: list[PivotPoint] = [
    pivot("high", 100, 1),
    pivot("low", 50, 2),
    pivot("high", 90, 3),
    pivot("low", 40, 4),
]


def test_emits_a_choch_hint_against_the_trend_then_confirms_on_the_flip() -> None:
    # Downtrend → HH CHoCH at 110 → HL at 60 completes uptrend labels.
    structure = compute_market_structure([*DOWNTREND, pivot("high", 110, 5), pivot("low", 60, 6)])
    transitions = derive_trend_transitions(structure)
    # [0] is the opening range→downtrend formation the fixture itself prints.
    assert len(transitions) == 2
    assert (transitions[0].from_trend, transitions[0].to_trend, transitions[0].phase) == (
        "range",
        "downtrend",
        "confirmed",
    )
    assert (transitions[1].from_trend, transitions[1].to_trend, transitions[1].phase) == (
        "downtrend",
        "uptrend",
        "confirmed",
    )
    assert transitions[1].time == 6
    assert transitions[1].choch_swing is not None
    assert transitions[1].choch_swing.time == 5
    assert transitions[1].confirm_swing is not None
    assert transitions[1].confirm_swing.time == 6
    assert structure.trend == "uptrend"


def test_holds_the_hint_through_the_range_interlude() -> None:
    # The CHoCH alone: labels HH beside the stale LL read as range, but the
    # hint must survive that interlude awaiting its confirming swing.
    structure = compute_market_structure([*DOWNTREND, pivot("high", 110, 5)])
    latest = latest_transition(structure)
    assert latest is not None
    assert (latest.from_trend, latest.to_trend, latest.phase) == (
        "downtrend",
        "uptrend",
        "choch-hint",
    )
    assert latest.confirm_swing is None
    assert latest.time == 5


def test_keeps_a_failed_hint_in_history_unconfirmed_when_the_market_resumes() -> None:
    # CHoCH HH at 110, then a new LL at 30 — the reversal died.
    structure = compute_market_structure([*DOWNTREND, pivot("high", 110, 5), pivot("low", 30, 6)])
    transitions = derive_trend_transitions(structure)
    assert len(transitions) == 2  # [0] = the opening range→downtrend formation
    assert transitions[1].phase == "choch-hint"
    assert transitions[1].confirm_swing is None
    # A later HL that would have confirmed the dead hint no longer counts:
    # the transition record is a fresh one, not the dead hint upgraded.
    resumed = compute_market_structure(
        [
            *DOWNTREND,
            pivot("high", 110, 5),
            pivot("low", 30, 6),
            pivot("high", 105, 7),
            pivot("low", 35, 8),
        ]
    )
    later = derive_trend_transitions(resumed)
    for t in later:
        if t.phase == "confirmed":
            assert (t.choch_swing.time if t.choch_swing else None) != 5


def test_records_structure_forming_straight_out_of_a_range_with_no_choch_swing() -> None:
    structure = compute_market_structure(
        [
            pivot("high", 100, 1),
            pivot("low", 50, 2),
            pivot("high", 110, 3),  # HH in range: forming, no event
            pivot("low", 60, 4),  # HL → uptrend
        ]
    )
    transitions = derive_trend_transitions(structure)
    assert len(transitions) == 1
    t = transitions[0]
    assert (t.from_trend, t.to_trend, t.phase, t.choch_swing, t.time) == (
        "range",
        "uptrend",
        "confirmed",
        None,
        4,
    )


def test_parity_the_folds_final_trend_always_equals_structure_trend() -> None:
    windows: list[list[Candle]] = [
        *(generate_mock_candles(s, "4H", 360) for s in ("BTC", "ETH", "SOL")),
    ]
    for name in DREIMANN_TRADES:
        fixture = load_dreimann_fixture(name)  # type: ignore[arg-type]
        entry_time = label_time(fixture.labels.entry.approx_time_utc)
        windows.append([c for c in fixture.series["4h"] if c.time <= entry_time])

    for candles in windows:
        for n in range(60, len(candles) + 1, 50):
            structure = compute_market_structure(compute_pivots(candles[:n]))
            transitions = derive_trend_transitions(structure)
            confirmed = [t for t in transitions if t.phase == "confirmed"]
            # The last confirmed transition's destination is the current trend,
            # unless the market has since fallen back into range.
            if structure.trend != "range":
                assert confirmed and confirmed[-1].to_trend == structure.trend
            # Structural coherence of every record.
            for t in transitions:
                assert t.from_trend != t.to_trend
                if t.phase == "confirmed":
                    assert t.confirm_swing is not None
                    assert t.time == t.confirm_swing.time
                else:
                    assert t.confirm_swing is None
                    assert t.choch_swing is not None
                if t.choch_swing is not None and t.confirm_swing is not None:
                    assert t.choch_swing.time <= t.confirm_swing.time


def test_deterministic_and_prefix_safe_a_confirmed_record_never_changes() -> None:
    # The fold is forward-only over structure.swings, so its guarantee is
    # stated on swing prefixes (candle-window prefixes reshuffle the pivots
    # themselves — compute_pivots adapts its window to the series length).
    candles = load_dreimann_fixture("zec-sl").series["4h"]
    structure = compute_market_structure(compute_pivots(candles))
    full = derive_trend_transitions(structure)
    assert derive_trend_transitions(structure) == full

    def key(t: TrendTransition) -> str:
        return f"{t.from_trend}>{t.to_trend}@{t.time}"

    confirmed_full = {key(t) for t in full if t.phase == "confirmed"}
    for m in range(1, len(structure.swings) + 1):
        sub = derive_trend_transitions(replace(structure, swings=structure.swings[:m]))
        for t in sub:
            if t.phase == "confirmed":
                # Confirmed at swing <= m ⇒ the full history holds it identically
                # (only live hints may still upgrade after the prefix ends).
                assert key(t) in confirmed_full
