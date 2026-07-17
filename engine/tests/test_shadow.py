"""Port of shadow.test.ts — the objective_resolved annotation keys nothing and
old records without it settle unchanged."""

from dataclasses import replace

from smc.analysis import compute_pivots
from smc.intent import INTENTS, IntentAssessment, assess_intent
from smc.mock_candles import generate_mock_candles
from smc.objectives import ObjectiveCandidate
from smc.quant import SignalEvaluation, evaluate_signal
from smc.shadow import ShadowSignal, build_shadow_signal, settle_shadow_signal
from smc.structure import SwingPoint
from smc.types import Candle

INTRADAY = next(d for d in INTENTS if d.intent == "intraday")
_CANDLES = generate_mock_candles("BTC", "1H", 200)
BASE = evaluate_signal("BTC", _CANDLES, compute_pivots(_CANDLES))


def favored_assessment(objectives: list[ObjectiveCandidate]) -> IntentAssessment:
    execution: SignalEvaluation = replace(
        BASE,
        components=[],
        no_trade_reasons=[],
        direction="long",
        decision="buy-candidate",
        setup_type="breakout",
        regime="trending-up",
        structure=replace(BASE.structure, trend="uptrend", event=None, event_swing=None),
        confidence=70,
        analytics=replace(BASE.analytics, last_close=100, support=99, resistance=110),
        risk=replace(BASE.risk, direction="long", entry=100, stop=98, target1=104, target2=108),
        objectives=objectives,
        anticipatory_plan=None,
    )
    context: SignalEvaluation = replace(
        BASE,
        components=[],
        no_trade_reasons=[],
        direction="long",
        regime="trending-up",
        structure=replace(BASE.structure, trend="uptrend", event=None, event_swing=None),
        liquidity=[],
    )
    assessment = assess_intent(INTRADAY, {"4H": context, "1H": execution})
    assert assessment is not None
    assert assessment.verdict == "favored"
    return assessment


class TestBuildShadowSignalObjectiveResolved:
    def test_tags_true_when_execution_resolved_objectives(self) -> None:
        assessment = favored_assessment(
            [
                ObjectiveCandidate(
                    direction="long",
                    swing=SwingPoint(kind="high", price=108, time=42),
                    strength="weak",
                    price=108,
                    pool=None,
                )
            ]
        )
        draft = build_shadow_signal(assessment, "btc", "spot", "2026-07-10T00:00:00.000Z")
        assert draft is not None
        assert draft.objective_resolved is True
        # The keyed fields are untouched by the annotation.
        assert draft.setup_type == "breakout"
        assert draft.regime == "trending-up"

    def test_tags_false_when_no_clean_objective_existed(self) -> None:
        draft = build_shadow_signal(
            favored_assessment([]), "btc", "spot", "2026-07-10T00:00:00.000Z"
        )
        assert draft is not None
        assert draft.objective_resolved is False


class TestSettleWithPreAnnotationRecords:
    def test_settles_old_record_without_objective_resolved(self) -> None:
        # A persisted record from before Phase 1 — the optional field is None.
        signal = ShadowSignal(
            id="legacy-1",
            symbol="BTC",
            market="spot",
            intent="intraday",
            direction="long",
            setup_type="breakout",
            regime="trending-up",
            timeframe="1H",
            entry=100,
            stop=98,
            target1=104,
            target2=108,
            confidence=70,
            opened_at="2026-07-10T00:00:00.000Z",
            status="active",
        )
        opened = 1783987200  # 2026-07-10T00:00:00Z
        bars = [Candle(time=opened + 3600, open=100, high=105, low=100, close=104.5, volume=1)]
        patch = settle_shadow_signal(signal, bars)
        assert patch is not None
        assert patch.status == "target1-hit"
