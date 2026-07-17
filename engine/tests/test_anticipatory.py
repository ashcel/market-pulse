"""Port of anticipatory.test.ts — the Phase 0.5 fill model. A resting limit
either fills (first closed-bar touch, inclusive, at the limit price) or
expires never-filled with no R; once filled it walks stop-first with the fill
bar unable to credit the objective. These conventions are EDR 0010's —
structural, never tuned."""

from dataclasses import replace
from typing import cast

from smc.anticipatory import (
    AnticipatorySignal,
    AnticipatorySignalStatus,
    build_anticipatory_signal,
    is_open_anticipatory_status,
    settle_anticipatory_signal,
    summarize_anticipatory_record,
)
from smc.hysteresis import INTENT_MAX_HOLD_BARS, iso_from_ms
from smc.intent import IntentAssessment, IntentDefinition
from smc.objectives import ObjectiveCandidate
from smc.poi import AnticipatoryPlan
from smc.structure import SwingPoint
from smc.types import Candle
from smc.zones import BaseZone
from tests.dreimann import label_time, load_dreimann_fixture

HOUR = 3600


def bar(time: int, low: float, high: float, close: float | None = None) -> Candle:
    mid = (low + high) / 2
    return Candle(
        time=time, open=mid, high=high, low=low, close=close if close is not None else mid,
        volume=1,
    )


def pending_long(**overrides: object) -> AnticipatorySignal:
    """A pending long: limit 100, stop 95, objective 115, opened at t=0, 1H bars."""
    signal = AnticipatorySignal(
        id="t-1",
        symbol="TEST",
        market="spot",
        intent="intraday",  # 24-bar horizon
        direction="long",
        setup_type="pullback-continuation",
        regime="trending-up",
        timeframe="1H",
        verdict="wait",
        entry=100,
        stop=95,
        objective=115,
        objective_strength="weak",
        zone_freshness="fresh",
        reward_risk=3,
        opened_at=iso_from_ms(0),
        status="pending",
    )
    return replace(signal, **overrides)  # type: ignore[arg-type]


def away_bars(n: int) -> list[Candle]:
    """n bars from t=1h that never reach down to the limit (stay 105-110)."""
    return [bar((i + 1) * HOUR, 105, 110) for i in range(n)]


class TestPending:
    def test_null_while_limit_rests_and_horizon_incomplete(self) -> None:
        assert settle_anticipatory_signal(pending_long(), away_bars(5)) is None

    def test_never_filled_without_r_once_horizon_completes(self) -> None:
        max_bars = INTENT_MAX_HOLD_BARS["intraday"]
        patch = settle_anticipatory_signal(pending_long(), away_bars(max_bars))
        assert patch is not None
        assert patch.status == "never-filled"
        assert patch.closed_at == iso_from_ms((max_bars * HOUR + HOUR) * 1000)
        assert patch.result_r is None
        assert patch.close_price is None

    def test_touch_at_exactly_limit_price_fills_inclusive(self) -> None:
        patch = settle_anticipatory_signal(pending_long(), [bar(HOUR, 100, 108)])
        assert patch is not None
        assert patch.status == "filled"
        assert patch.filled_at == iso_from_ms(HOUR * 1000)

    def test_ignores_bars_at_or_before_adoption(self) -> None:
        # The forming bar cannot fill.
        assert settle_anticipatory_signal(pending_long(), [bar(0, 90, 108)]) is None

    def test_fill_after_pending_horizon_does_not_count(self) -> None:
        # The limit was cancelled.
        max_bars = INTENT_MAX_HOLD_BARS["intraday"]
        bars = [*away_bars(max_bars), bar((max_bars + 1) * HOUR, 99, 104)]
        patch = settle_anticipatory_signal(pending_long(), bars)
        assert patch is not None
        assert patch.status == "never-filled"

    def test_resolves_fill_and_outcome_in_one_pass(self) -> None:
        bars = [bar(HOUR, 99, 104), bar(2 * HOUR, 103, 116)]
        patch = settle_anticipatory_signal(pending_long(), bars)
        assert patch is not None
        assert patch.status == "objective-hit"
        assert patch.filled_at == iso_from_ms(HOUR * 1000)
        assert patch.close_price == 115
        # R measured from the limit: (115 - 100) / (100 - 95) = 3.
        assert patch.result_r == 3


class TestFillBar:
    def test_stops_out_on_fill_bar_when_it_sweeps_the_stop(self) -> None:
        patch = settle_anticipatory_signal(pending_long(), [bar(HOUR, 94, 106)])
        assert patch is not None
        assert patch.status == "stopped-out"
        assert patch.filled_at == iso_from_ms(HOUR * 1000)
        assert patch.result_r == -1

    def test_fill_bar_gets_no_objective_credit(self) -> None:
        # One huge bar touches the limit AND the objective: stays open.
        patch = settle_anticipatory_signal(pending_long(), [bar(HOUR, 99, 120)])
        assert patch is not None
        assert patch.status == "filled"
        assert patch.close_price is None
        # The very next bar reaching the objective does count.
        filled = replace(pending_long(), status="filled", filled_at=patch.filled_at)
        next_ = settle_anticipatory_signal(filled, [bar(HOUR, 99, 120), bar(2 * HOUR, 110, 116)])
        assert next_ is not None
        assert next_.status == "objective-hit"

    def test_stop_checked_before_objective_on_later_bars(self) -> None:
        fill = settle_anticipatory_signal(pending_long(), [bar(HOUR, 99, 104)])
        assert fill is not None
        filled = replace(pending_long(), status="filled", filled_at=fill.filled_at)
        both = settle_anticipatory_signal(filled, [bar(HOUR, 99, 104), bar(2 * HOUR, 94, 116)])
        assert both is not None
        assert both.status == "stopped-out"


def filled_signal() -> AnticipatorySignal:
    return replace(pending_long(), status="filled", filled_at=iso_from_ms(HOUR * 1000))


class TestFilledPositions:
    def test_expires_at_hold_horizon_with_r_from_last_close(self) -> None:
        max_bars = INTENT_MAX_HOLD_BARS["intraday"]
        bars = [bar((i + 1) * HOUR, 101, 106, 102.5) for i in range(max_bars)]
        patch = settle_anticipatory_signal(filled_signal(), bars)
        assert patch is not None
        assert patch.status == "expired"
        # (102.5 - 100) / 5 = 0.5.
        assert patch.result_r == 0.5

    def test_null_while_position_open_and_horizon_incomplete(self) -> None:
        assert (
            settle_anticipatory_signal(
                filled_signal(), [bar(HOUR, 101, 106), bar(2 * HOUR, 102, 107)]
            )
            is None
        )

    def test_mirrors_for_shorts(self) -> None:
        short = pending_long(direction="short", entry=100, stop=105, objective=85)
        fill = settle_anticipatory_signal(short, [bar(HOUR, 96, 101)])
        assert fill is not None
        assert fill.status == "filled"
        filled = replace(short, status="filled", filled_at=fill.filled_at)
        win = settle_anticipatory_signal(filled, [bar(HOUR, 96, 101), bar(2 * HOUR, 84, 98)])
        assert win is not None
        assert win.status == "objective-hit"
        assert win.result_r == 3

    def test_append_only_terminal_patches_never_contradicted(self) -> None:
        signal = pending_long()
        full = [bar(HOUR, 99, 104), bar(2 * HOUR, 103, 116), bar(3 * HOUR, 90, 105)]
        settled = signal
        terminal = None
        for n in range(1, len(full) + 1):
            patch = settle_anticipatory_signal(settled, full[:n])
            if patch is not None:
                settled = replace(
                    settled,
                    status=patch.status,
                    filled_at=patch.filled_at or settled.filled_at,
                    closed_at=patch.closed_at or settled.closed_at,
                    close_price=patch.close_price
                    if patch.close_price is not None
                    else settled.close_price,
                    result_r=patch.result_r if patch.result_r is not None else settled.result_r,
                )
            if terminal is not None:
                assert patch is None  # terminal states never re-patch
            elif patch is not None and not is_open_anticipatory_status(settled.status):
                terminal = patch
                # bar 2, before bar 3's stop sweep
                assert patch.status == "objective-hit"
        assert terminal is not None


def minimal_assessment(plan: AnticipatoryPlan | None) -> IntentAssessment:
    """The structural subset build_anticipatory_signal reads (the TS test used
    an untyped stub; here the same shape is expressed through the dataclass)."""
    base = IntentAssessment.__new__(IntentAssessment)
    exe_attrs = {"setup_type": "pullback-continuation", "regime": "trending-up"}
    execution = cast("object", type("Exe", (), exe_attrs)())
    definition = IntentDefinition(
        intent="intraday",
        label="Intraday",
        horizon="hours",
        context_timeframe="4H",
        execution_timeframe="1H",
        description="",
    )
    object.__setattr__(base, "intent", "intraday")
    object.__setattr__(base, "verdict", "wait")
    object.__setattr__(base, "definition", definition)
    object.__setattr__(base, "execution", execution)
    object.__setattr__(base, "anticipatory_plan", plan)
    return base


class TestBuildAndSummarize:
    def test_returns_none_without_plan_and_freezes_plan_when_present(self) -> None:
        assert build_anticipatory_signal(minimal_assessment(None), "eth", "spot", "now") is None

        plan = AnticipatoryPlan(
            direction="long",
            zone=BaseZone(
                kind="demand",
                price_low=95,
                price_high=100,
                start_time=1,
                end_time=2,
                freshness="fresh",
            ),
            entry=100,
            stop=95,
            objective=ObjectiveCandidate(
                direction="long",
                swing=SwingPoint(kind="high", price=115, time=42),
                strength="weak",
                price=115,
                pool=None,
            ),
            risk_per_unit=5,
            reward_per_unit=15,
            reward_risk=3,
            entry_position="discount",
        )
        draft = build_anticipatory_signal(
            minimal_assessment(plan), "eth", "spot", "2026-07-10T00:00:00.000Z"
        )
        assert draft is not None
        assert draft.symbol == "ETH"
        assert draft.direction == "long"
        assert draft.entry == 100
        assert draft.stop == 95
        assert draft.objective == 115
        assert draft.objective_strength == "weak"
        assert draft.zone_freshness == "fresh"
        assert draft.reward_risk == 3
        assert draft.verdict == "wait"
        assert draft.timeframe == "1H"

    def test_summarize_fill_rate_and_r_over_settled_only(self) -> None:
        def s(
            status: AnticipatorySignalStatus, result_r: float | None = None
        ) -> AnticipatorySignal:
            return replace(pending_long(), status=status, result_r=result_r)

        summary = summarize_anticipatory_record(
            [
                s("pending"),
                s("filled"),
                s("never-filled"),
                s("never-filled"),
                s("objective-hit", 3),
                s("stopped-out", -1),
                s("expired", 0.5),
            ]
        )
        assert summary.total == 7
        assert summary.pending == 1
        assert summary.open == 1
        assert summary.never_filled == 2
        assert summary.filled == 4  # 1 open + 3 settled
        assert summary.fill_rate == round(4 / 6 * 100, 1)
        assert summary.settled == 3
        assert summary.wins == 2  # positive R: objective-hit and expired at +0.5
        assert summary.losses == 1
        assert summary.average_r == round((3 - 1 + 0.5) / 3, 2)
        assert summary.low_sample is True


class TestDreimannZecSl:
    """The instructive loss, graded by the harness exactly as it played out."""

    fixture = load_dreimann_fixture("zec-sl")
    bars = fixture.series["4h"]
    entry_time = label_time(fixture.labels.entry.approx_time_utc)

    def trader_plan(self) -> AnticipatorySignal:
        # Adopted just before the labeled fill bar so that bar can fill it.
        return pending_long(
            symbol="ZECUSDT",
            intent="swing",  # 42 x 4H
            timeframe="4H",
            entry=self.fixture.labels.entry.price,  # 450.49
            stop=self.fixture.labels.stop_price,  # 446.05 — inside the POI's noise
            objective=self.fixture.labels.objective.price,  # 476.9
            opened_at=iso_from_ms((self.entry_time - 1) * 1000),
        )

    def test_grades_the_traders_actual_plan(self) -> None:
        # The 04:00Z Jul 7 bar wicked to 443.82: through the limit AND the stop.
        patch = settle_anticipatory_signal(self.trader_plan(), self.bars)
        assert patch is not None
        assert patch.status == "stopped-out"
        assert patch.filled_at == iso_from_ms(self.entry_time * 1000)
        assert patch.result_r == -1

    def test_grades_same_entry_with_edr_0009_stop_outside_noise(self) -> None:
        # Same limit, stop below the sweep's 443.82 extreme (the distal-edge
        # lesson): the position survives the wick and the 12:00Z rally prints
        # the 476.9 objective — "would have reached TP without stop".
        survivable = replace(self.trader_plan(), stop=443.0)
        patch = settle_anticipatory_signal(survivable, self.bars)
        assert patch is not None
        assert patch.status == "objective-hit"
        assert patch.result_r is not None
        assert patch.result_r > 3
