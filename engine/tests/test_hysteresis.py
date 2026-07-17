"""New pins for hysteresis.py (the TS module had no dedicated suite): a hold
stands until its own release condition fires — invalidation break, context
flip, upgrade, or staleness."""

from dataclasses import replace

from smc.analysis import compute_pivots
from smc.hysteresis import (
    INTENT_MAX_HOLD_BARS,
    HeldVerdict,
    ReconcileEntry,
    ReconcileResult,
    hold_key,
    iso_from_ms,
    reconcile_holds,
)
from smc.intent import INTENTS, IntentAssessment, assess_intent
from smc.mock_candles import STEP_SECONDS, generate_mock_candles
from smc.quant import SignalEvaluation, evaluate_signal

INTRADAY = next(d for d in INTENTS if d.intent == "intraday")
_CANDLES = generate_mock_candles("BTC", "1H", 200)
BASE = evaluate_signal("BTC", _CANDLES, compute_pivots(_CANDLES))

NOW_MS = 1_752_000_000_000


def execution(last_close: float = 100.0, **overrides: object) -> SignalEvaluation:
    return replace(
        BASE,
        components=[],
        no_trade_reasons=[],
        direction="long",
        decision="buy-candidate",
        setup_type="breakout",
        regime="trending-up",
        structure=replace(BASE.structure, trend="uptrend", event=None, event_swing=None),
        confidence=70,
        analytics=replace(
            BASE.analytics, last_close=last_close, support=99, resistance=110, atr_percent=1
        ),
        risk=replace(BASE.risk, direction="long", entry=last_close, target1=104),
        **overrides,  # type: ignore[arg-type]
    )


def context() -> SignalEvaluation:
    return replace(
        BASE,
        components=[],
        no_trade_reasons=[],
        direction="long",
        regime="trending-up",
        structure=replace(BASE.structure, trend="uptrend", event=None, event_swing=None),
        liquidity=[],
        analytics=replace(BASE.analytics, atr_percent=2),
    )


def favored(last_close: float = 100.0) -> IntentAssessment:
    assessment = assess_intent(INTRADAY, {"4H": context(), "1H": execution(last_close)})
    assert assessment is not None
    assert assessment.verdict == "favored"
    return assessment


def reconcile(
    assessment: IntentAssessment,
    holds: dict[str, HeldVerdict],
    now_ms: float,
    favored_before: bool = True,
) -> ReconcileResult:
    return reconcile_holds(
        symbol="BTC",
        market="spot",
        entries=[
            ReconcileEntry(assessment=assessment, favored_before_adjustment=favored_before)
        ],
        holds=holds,
        now_ms=now_ms,
    )


class TestAdoption:
    def test_first_reconcile_adopts_and_reports_opened_favored(self) -> None:
        result = reconcile(favored(), {}, NOW_MS)
        key = hold_key("BTC", "spot", "intraday")
        assert key in result.updates
        adopted = result.updates[key]
        assert adopted.verdict == "favored"
        assert adopted.held_at == iso_from_ms(NOW_MS)
        # A long's invalidation is support, below; its upgrade is resistance, above.
        assert adopted.invalidation is not None
        assert adopted.invalidation.level == 99
        assert adopted.invalidation.side == "below"
        assert adopted.upgrade_trigger is not None
        assert adopted.upgrade_trigger.level == 110
        assert len(result.opened_favored) == 1
        assert result.display[0].hold.is_held is False

    def test_not_favored_before_adjustment_opens_nothing(self) -> None:
        result = reconcile(favored(), {}, NOW_MS, favored_before=False)
        assert result.opened_favored == []


class TestHolding:
    def adopt(self) -> dict[str, HeldVerdict]:
        return dict(reconcile(favored(), {}, NOW_MS).updates)

    def test_hold_stands_while_no_release_condition_fires(self) -> None:
        holds = self.adopt()
        # Fresh read one bar later, nothing broken (close 100 > support 99).
        later = NOW_MS + STEP_SECONDS["1H"] * 1000
        result = reconcile(favored(), holds, later)
        assert result.updates == {}
        assert result.opened_favored == []
        assert result.display[0].hold.is_held is True
        assert result.display[0].hold.held_at == iso_from_ms(NOW_MS)

    def test_invalidation_break_releases_with_note(self) -> None:
        holds = self.adopt()
        later = NOW_MS + STEP_SECONDS["1H"] * 1000
        # 1H closed below the 99 support the hold named as its invalidation.
        broken = assess_intent(INTRADAY, {"4H": context(), "1H": execution(last_close=98.5)})
        assert broken is not None
        result = reconcile(broken, holds, later)
        key = hold_key("BTC", "spot", "intraday")
        assert key in result.updates
        note = result.updates[key].adopted_because
        assert note is not None
        assert "closed below" in note

    def test_staleness_releases_without_note(self) -> None:
        holds = self.adopt()
        horizon_ms = INTENT_MAX_HOLD_BARS["intraday"] * STEP_SECONDS["1H"] * 1000
        result = reconcile(favored(), holds, NOW_MS + horizon_ms + 1000)
        key = hold_key("BTC", "spot", "intraday")
        assert key in result.updates
        assert result.updates[key].adopted_because is None

    def test_held_display_keeps_the_held_verdict_over_fresh_context(self) -> None:
        holds = self.adopt()
        later = NOW_MS + STEP_SECONDS["1H"] * 1000
        result = reconcile(favored(), holds, later)
        display = result.display[0]
        held = holds[hold_key("BTC", "spot", "intraday")]
        assert display.verdict == held.verdict
        assert display.headline == held.headline
        assert display.plan == held.plan
