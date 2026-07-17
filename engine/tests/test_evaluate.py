"""Port of evaluate.test.ts plus pins for the full pipeline: assess →
record-adjust → reconcile-holds → open records."""

import time
from dataclasses import replace

from smc.analysis import compute_pivots
from smc.evaluate import EvaluateInput, evaluate_symbol
from smc.mock_candles import generate_mock_candles
from smc.quant import SignalEvaluation, evaluate_signal
from smc.version import ENGINE_VERSION

_CANDLES = generate_mock_candles("BTC", "1H", 200)
BASE = evaluate_signal("BTC", _CANDLES, compute_pivots(_CANDLES))


def favored_execution() -> SignalEvaluation:
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
            BASE.analytics, last_close=100, support=99, resistance=110, atr_percent=1
        ),
        risk=replace(BASE.risk, direction="long", entry=100, stop=98, target1=104, target2=108),
    )


def context_eval() -> SignalEvaluation:
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


def test_returns_none_when_nothing_to_assess() -> None:
    out = evaluate_symbol(
        EvaluateInput(
            symbol="BTC",
            market="spot",
            evals_by_timeframe={},
            zones_by_timeframe={},
            perp=None,
            session_levels=[],
            combo_stats=[],
            holds={},
            now_ms=time.time() * 1000,
        )
    )
    assert out is None


def test_favored_call_opens_a_provenance_stamped_shadow_record() -> None:
    out = evaluate_symbol(
        EvaluateInput(
            symbol="BTC",
            market="spot",
            evals_by_timeframe={"4H": context_eval(), "1H": favored_execution()},
            zones_by_timeframe={},
            perp=None,
            session_levels=[],
            combo_stats=[],
            holds={},
            now_ms=1_752_000_000_000,
        )
    )
    assert out is not None
    # The intraday assessment (4H context, 1H execution) reaches favored.
    intraday = next(d for d in out.display if d.intent == "intraday")
    assert intraday.verdict == "favored"
    assert len(out.shadow_to_open) >= 1
    draft = out.shadow_to_open[0]
    assert draft.engine_version == ENGINE_VERSION
    assert draft.config_hash
    assert draft.git_sha
    # Every changed hold is returned for persistence.
    assert len(out.hold_updates) == len(out.display)


def test_standing_holds_suppress_reopen() -> None:
    evals = {"4H": context_eval(), "1H": favored_execution()}
    first = evaluate_symbol(
        EvaluateInput(
            symbol="BTC",
            market="spot",
            evals_by_timeframe=evals,  # type: ignore[arg-type]
            zones_by_timeframe={},
            perp=None,
            session_levels=[],
            combo_stats=[],
            holds={},
            now_ms=1_752_000_000_000,
        )
    )
    assert first is not None
    second = evaluate_symbol(
        EvaluateInput(
            symbol="BTC",
            market="spot",
            evals_by_timeframe=evals,  # type: ignore[arg-type]
            zones_by_timeframe={},
            perp=None,
            session_levels=[],
            combo_stats=[],
            holds=first.hold_updates,
            now_ms=1_752_000_000_000 + 3600 * 1000,
        )
    )
    assert second is not None
    # Nothing changed, so no hold updates and no new shadow records.
    assert second.hold_updates == {}
    assert second.shadow_to_open == []
    assert all(d.hold.is_held for d in second.display)
