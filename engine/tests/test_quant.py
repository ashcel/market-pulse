"""Port of quant.test.ts, plus the evaluate_signal regression tests deferred
from analysis.test.ts and liquidity.test.ts."""

import math

import pytest

import smc.quant
from smc.analysis import compute_pivots, pivot_window
from smc.mock_candles import generate_mock_candles
from smc.quant import (
    DEFAULT_RISK_SETTINGS,
    evaluate_signal,
    grade_risk,
    run_backtest,
)
from smc.types import Candle


class TestRunBacktestReplayPivotSafety:
    def test_uses_compute_pivots_of_the_prefix_window_as_the_replay_oracle(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pivot_inputs: list[list[Candle]] = []
        real = compute_pivots

        def recorder(candles: list[Candle]) -> list:  # type: ignore[type-arg]
            pivot_inputs.append(candles)
            return real(candles)

        monkeypatch.setattr(smc.quant, "compute_pivots", recorder)
        candles = generate_mock_candles("BTC", "1H", 70)
        run_backtest(candles, DEFAULT_RISK_SETTINGS, "breakout")

        assert len(pivot_inputs) == 10
        for offset, pivot_input in enumerate(pivot_inputs):
            replay_bar = 55 + offset
            assert pivot_input == candles[: replay_bar + 1]
            assert pivot_input is not candles
            assert len(pivot_input) < len(candles)

    def test_does_not_expose_pivots_before_their_confirmation_window_closed(self) -> None:
        candles = generate_mock_candles("DOGE", "1H", 160)
        inspected = 0
        for i in range(55, len(candles) - 5):
            window = candles[: i + 1]
            k = pivot_window(len(window))
            index_by_time = {c.time: idx for idx, c in enumerate(window)}
            for pivot in compute_pivots(window):
                pivot_index = index_by_time.get(pivot.time)
                assert pivot_index is not None
                assert pivot_index + k <= i
                inspected += 1
        assert inspected > 0

    def test_produces_deterministic_replay_summaries(self) -> None:
        candles = generate_mock_candles("SOL", "1H", 1000)
        first = run_backtest(candles, DEFAULT_RISK_SETTINGS, "lower-high-rejection")
        second = run_backtest(candles, DEFAULT_RISK_SETTINGS, "lower-high-rejection")
        assert second == first


class TestGradeRisk:
    def test_grades_by_the_atr_bands(self) -> None:
        assert grade_risk(1.0) == "low"
        assert grade_risk(2.2) == "medium"
        assert grade_risk(3.0) == "medium"
        assert grade_risk(4.5) == "high"
        assert grade_risk(7.0) == "high"

    def test_bumps_a_counter_trend_trade_one_grade_capped_at_high(self) -> None:
        assert grade_risk(1.0, True) == "medium"
        assert grade_risk(3.0, True) == "high"
        assert grade_risk(7.0, True) == "high"

    def test_returns_none_without_an_atr_read(self) -> None:
        assert grade_risk(None) is None
        assert grade_risk(math.nan) is None


class TestEvaluateSignalRegression:
    """Deferred from analysis.test.ts / liquidity.test.ts — downstream
    consumers accept the full pivot set."""

    def test_evaluate_signal_produces_a_valid_evaluation_with_the_full_pivot_set(self) -> None:
        candles = generate_mock_candles("SOL", "1H", 200)
        pivots = compute_pivots(candles)
        evaluation = evaluate_signal("SOL", candles, pivots, DEFAULT_RISK_SETTINGS)

        assert evaluation.symbol == "SOL"
        assert 0 <= evaluation.confidence <= 100
        assert evaluation.setup_type
        assert evaluation.decision
        assert evaluation.direction
        assert evaluation.regime
        assert evaluation.risk is not None
        assert evaluation.analytics is not None
        assert evaluation.backtest is not None

    def test_evaluate_signal_with_separate_backtest_candles(self) -> None:
        candles = generate_mock_candles("SOL", "1H", 200)
        pivots = compute_pivots(candles)
        backtest_candles = generate_mock_candles("SOL", "1H", 500)
        evaluation = evaluate_signal(
            "SOL", candles, pivots, DEFAULT_RISK_SETTINGS, backtest_candles
        )
        assert evaluation.backtest.strategy_version
        assert isinstance(evaluation.backtest.total_trades, int)

    def test_liquidity_pools_are_exposed_on_every_evaluation(self) -> None:
        candles = generate_mock_candles("BTC", "1H", 500)
        evaluation = evaluate_signal("BTC", candles, compute_pivots(candles))
        assert isinstance(evaluation.liquidity, list)
        for pool in evaluation.liquidity:
            assert pool.side in ("bsl", "ssl")
            assert math.isfinite(pool.price)

    def test_liquidity_sweeps_are_exposed_and_reference_the_pools(self) -> None:
        candles = generate_mock_candles("BTC", "1H", 500)
        evaluation = evaluate_signal("BTC", candles, compute_pivots(candles))
        assert isinstance(evaluation.liquidity_sweeps, list)
        for sweep in evaluation.liquidity_sweeps:
            assert sweep.side in ("bsl", "ssl")
            assert any(sweep.pool is pool for pool in evaluation.liquidity)
