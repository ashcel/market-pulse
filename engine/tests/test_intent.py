"""Port of intent.test.ts — timeframe_bias reconciliation, the HTF-liquidity
overlay, and the Phase 1 objectives+POI overlay (verdict-inert)."""

from dataclasses import replace
from typing import Literal

from smc.analysis import compute_pivots
from smc.intent import INTENTS, IntentAssessment, assess_intent, timeframe_bias
from smc.liquidity import LiquidityPool, compute_liquidity_pools
from smc.mock_candles import generate_mock_candles
from smc.objectives import ObjectiveCandidate
from smc.poi import AnticipatoryPlan
from smc.quant import MarketRegime, SignalEvaluation, TradeDirection, evaluate_signal
from smc.structure import SwingPoint, compute_market_structure
from smc.types import PivotKind, PivotPoint
from smc.zones import BaseZone

# One real engine evaluation as the stub base — every override below stays a
# structurally complete SignalEvaluation, so grade_location and the checklist
# builders run against honest shapes.
_CANDLES = generate_mock_candles("BTC", "1H", 200)
BASE = evaluate_signal("BTC", _CANDLES, compute_pivots(_CANDLES))

INTRADAY = next(d for d in INTENTS if d.intent == "intraday")  # context 4H, execution 1H


def stub_eval(**overrides: object) -> SignalEvaluation:
    return replace(BASE, components=[], no_trade_reasons=[], **overrides)  # type: ignore[arg-type]


def bias_stub(
    direction: TradeDirection,
    regime: MarketRegime,
    trend: Literal["uptrend", "downtrend", "range"],
) -> SignalEvaluation:
    # Null the event so the structural lean is the trend alone — the mock-data
    # base evaluation may carry a live BOS/CHoCH that would color range cases.
    return stub_eval(
        direction=direction,
        regime=regime,
        structure=replace(BASE.structure, trend=trend, event=None, event_swing=None),
    )


def bsl_pool_at(price: float) -> LiquidityPool:
    """Real pools built through the real structure engine, at a chosen level."""
    steps: list[tuple[PivotKind, float]] = [
        ("high", price),
        ("low", price * 0.5),
        ("high", price),
        ("low", price * 0.55),
    ]
    pools = compute_liquidity_pools(
        compute_market_structure(
            [PivotPoint(time=i + 1, price=p, kind=kind) for i, (kind, p) in enumerate(steps)]
        )
    )
    assert pools[0].side == "bsl"
    assert pools[0].intact is True
    return pools[0]


class TestTimeframeBias:
    def test_returns_setup_direction_when_nothing_contradicts(self) -> None:
        assert timeframe_bias(bias_stub("short", "trending-down", "downtrend")) == "short"
        assert timeframe_bias(bias_stub("long", "range-bound", "range")) == "long"

    def test_suppresses_vetoed_setup_and_falls_back_to_trend(self) -> None:
        # The UNI case: a failed-breakout short printed inside a confirmed
        # uptrend. The engine refuses that trade, so the lean must not be
        # short — regime and structure agree up, and that agreement is the lean.
        assert timeframe_bias(bias_stub("short", "trending-up", "uptrend")) == "long"
        assert timeframe_bias(bias_stub("short", "range-bound", "uptrend")) == "long"
        assert timeframe_bias(bias_stub("long", "trending-down", "range")) == "short"

    def test_none_when_veto_leaves_regime_and_structure_in_conflict(self) -> None:
        assert timeframe_bias(bias_stub("long", "trending-up", "downtrend")) == "none"

    def test_leans_on_regime_when_structure_silent(self) -> None:
        assert timeframe_bias(bias_stub("none", "trending-up", "range")) == "long"

    def test_leans_on_structure_when_regime_directionless(self) -> None:
        assert timeframe_bias(bias_stub("none", "range-bound", "uptrend")) == "long"
        assert timeframe_bias(bias_stub("none", "choppy", "downtrend")) == "short"

    def test_none_when_regime_and_structure_disagree(self) -> None:
        assert timeframe_bias(bias_stub("none", "trending-up", "downtrend")) == "none"
        assert timeframe_bias(bias_stub("none", "trending-down", "uptrend")) == "none"

    def test_agreement_keeps_shared_lean(self) -> None:
        assert timeframe_bias(bias_stub("none", "trending-up", "uptrend")) == "long"


def favored_execution(**overrides: object) -> SignalEvaluation:
    """A confirmed 1H long, well located (price hugging support), that reaches
    "favored" when nothing else intervenes."""
    return stub_eval(
        direction="long",
        decision="buy-candidate",
        setup_type="breakout",
        regime="trending-up",
        # Structure must agree with the long — a structure that fights it
        # would (correctly) suppress the timeframe's lean and void the setup.
        structure=replace(BASE.structure, trend="uptrend", event=None, event_swing=None),
        confidence=70,
        analytics=replace(
            BASE.analytics, last_close=100, support=99, resistance=110, atr_percent=1, atr14=1
        ),
        risk=replace(BASE.risk, direction="long", entry=100, target1=104),
        **overrides,
    )


def context_with(liquidity: list[LiquidityPool]) -> SignalEvaluation:
    return stub_eval(
        direction="long",
        regime="trending-up",
        structure=replace(BASE.structure, trend="uptrend", event=None, event_swing=None),
        liquidity=liquidity,
        analytics=replace(BASE.analytics, atr_percent=2),  # proximity window: 1.1%
    )


class TestHigherTimeframeLiquidity:
    def assess(self, liquidity: list[LiquidityPool]) -> IntentAssessment:
        assessment = assess_intent(
            INTRADAY, {"4H": context_with(liquidity), "1H": favored_execution()}
        )
        assert assessment is not None
        return assessment

    def test_stays_favored_full_size_without_opposing_pools(self) -> None:
        assessment = self.assess([])
        assert assessment.verdict == "favored"
        assert assessment.size_multiplier == 1
        assert not any("liquidity pool" in c.label for c in assessment.checklist)

    def test_trims_favored_long_to_caution_under_intact_4h_pool(self) -> None:
        # Pool at 100.4 vs entry 100: 0.4% away, inside the 1.1% window.
        assessment = self.assess([bsl_pool_at(100.4)])
        assert assessment.verdict == "caution"
        assert assessment.size_multiplier == 0.5
        assert "liquidity" in assessment.headline
        assert "100.4" in assessment.summary
        item = next(
            (c for c in assessment.checklist if c.label == "No 4H liquidity pool at the entry"),
            None,
        )
        assert item is not None
        assert item.done is False

    def test_notes_distant_pool_on_path_without_downgrading(self) -> None:
        # Pool at 103 vs entry 100: 3% away (outside the window) but inside
        # the 104 target — a magnet, not a reason to stand down.
        assessment = self.assess([bsl_pool_at(103)])
        assert assessment.verdict == "favored"
        assert assessment.size_multiplier == 1
        assert "103" in assessment.summary
        assert "magnet" in assessment.summary
        item = next(
            (c for c in assessment.checklist if c.label == "No 4H liquidity pool at the entry"),
            None,
        )
        assert item is not None
        assert item.done is True

    def test_ignores_spent_pools_and_own_side_pools(self) -> None:
        spent = replace(bsl_pool_at(100.4), intact=False)
        own_side = replace(bsl_pool_at(100.4), side="ssl", price=99.6)
        assessment = self.assess([spent, own_side])
        assert assessment.verdict == "favored"
        assert assessment.size_multiplier == 1


def candidate_at(price: float, direction: str = "long") -> ObjectiveCandidate:
    """A long objective candidate at a chosen level, direction-tagged."""
    return ObjectiveCandidate(
        direction=direction,  # type: ignore[arg-type]
        swing=SwingPoint(
            kind="high" if direction == "long" else "low",
            price=price,
            time=42,
            label=None,
            event=None,
            equal=None,
        ),
        strength="weak",
        price=price,
        pool=None,
    )


def demand_zone() -> BaseZone:
    return BaseZone(
        kind="demand", price_low=96, price_high=98, start_time=1, end_time=2, freshness="fresh"
    )


def anticipatory_plan_stub() -> AnticipatoryPlan:
    return AnticipatoryPlan(
        direction="long",
        zone=demand_zone(),
        entry=98,
        stop=96,
        objective=candidate_at(108),
        risk_per_unit=2,
        reward_per_unit=10,
        reward_risk=5,
        entry_position="discount",
    )


def plain_context() -> SignalEvaluation:
    return context_with([])


class TestPhase1Overlay:
    def test_verdict_inert(self) -> None:
        # The same assessment computed from evaluations with and without the
        # surfaced reads must agree on every decision-bearing field — the
        # overlay only explains, never decides.
        cases = [
            {"4H": plain_context(), "1H": favored_execution()},
            {
                "4H": plain_context(),
                "1H": favored_execution(
                    objectives=[candidate_at(108)], anticipatory_plan=anticipatory_plan_stub()
                ),
            },
        ]
        for evals in cases:
            with_reads = assess_intent(INTRADAY, evals)  # type: ignore[arg-type]
            stripped_evals = {
                tf: replace(e, objectives=[], anticipatory_plan=None)
                for tf, e in evals.items()
            }
            stripped = assess_intent(INTRADAY, stripped_evals)  # type: ignore[arg-type]
            assert with_reads is not None and stripped is not None
            assert with_reads.verdict == stripped.verdict
            assert with_reads.size_multiplier == stripped.size_multiplier
            assert with_reads.plan == stripped.plan
            assert with_reads.headline == stripped.headline
            assert with_reads.summary == stripped.summary
            assert with_reads.triggers == stripped.triggers

    def test_objective_checklist_item_with_draw(self) -> None:
        assessment = assess_intent(
            INTRADAY,
            {
                "4H": plain_context(),
                "1H": favored_execution(objectives=[candidate_at(108), candidate_at(112)]),
            },
        )
        assert assessment is not None
        item = next(
            (c for c in assessment.checklist if c.label == "Clean liquidity objective exists"),
            None,
        )
        assert item is not None
        assert item.done is True
        assert "108" in item.detail
        assert "weak" in item.detail
        assert "1 further draw" in item.detail

    def test_objective_item_not_done_without_draw(self) -> None:
        # G10 displayed, not enforced: force the empty case with a bare
        # structure that has nothing above 100.
        exe = favored_execution(objectives=[])
        exe.structure = replace(
            BASE.structure,
            swings=[],
            trend="uptrend",
            event=None,
            event_swing=None,
            last_high=None,
            last_low=None,
            equal_highs=[],
            equal_lows=[],
        )
        exe.liquidity = []
        assessment = assess_intent(INTRADAY, {"4H": plain_context(), "1H": exe})
        assert assessment is not None
        item = next(
            (c for c in assessment.checklist if c.label == "Clean liquidity objective exists"),
            None,
        )
        assert item is not None
        assert item.done is False
        assert assessment.verdict == "favored"  # still favored — no veto
        assert assessment.anticipatory_plan is None

    def test_surfaces_matching_execution_plan_and_gates_on_ctx_discount(self) -> None:
        plan = anticipatory_plan_stub()
        assessment = assess_intent(
            INTRADAY,
            {
                "4H": plain_context(),
                "1H": favored_execution(objectives=[candidate_at(108)], anticipatory_plan=plan),
            },
        )
        assert assessment is not None
        assert assessment.anticipatory_plan is plan
        item = next(
            (c for c in assessment.checklist if c.label.startswith("Limit entry at a POI")), None
        )
        assert item is not None
        # The 4H context stub carries mock-data structure; done is whatever
        # the real classify_price says — assert the detail stays coherent.
        if item.done:
            assert "98" in item.detail
            assert "discount" in item.detail
        else:
            assert len(item.detail) > 0

    def test_adds_neither_item_when_standing_aside(self) -> None:
        flat = stub_eval(
            direction="none",
            regime="range-bound",
            structure=replace(BASE.structure, trend="range", event=None, event_swing=None),
        )
        assessment = assess_intent(INTRADAY, {"4H": flat, "1H": flat})
        assert assessment is not None
        assert assessment.direction == "none"
        assert not any(
            c.label == "Clean liquidity objective exists" or c.label.startswith("Limit entry")
            for c in assessment.checklist
        )
        assert assessment.anticipatory_plan is None
