/**
 * Reproducible replay-safe benchmark from the RFC approval notes.
 */
import { describe, it } from "vitest";
import { generateMockCandles } from "./mock-candles";
import { computePivots } from "./analysis";
import { evaluateSignal, DEFAULT_RISK_SETTINGS } from "./quant";

const ASSETS = ["BTC", "SOL", "DOGE"] as const;
const RUNS_PER_ASSET = 3;

describe("replay-safe backtest benchmark", () => {
  for (const symbol of ASSETS) {
    it(`${symbol}: averages ${RUNS_PER_ASSET} runs over 1000 1H candles`, () => {
      const candles = generateMockCandles(symbol, "1H", 200);
      const backtestCandles = generateMockCandles(symbol, "1H", 1000);
      const pivots = computePivots(candles);
      const elapsedRuns: number[] = [];
      let evaluation: ReturnType<typeof evaluateSignal> | null = null;

      for (let run = 0; run < RUNS_PER_ASSET; run++) {
        const startedAt = performance.now();
        evaluation = evaluateSignal(
          symbol,
          candles,
          pivots,
          DEFAULT_RISK_SETTINGS,
          backtestCandles,
        );
        elapsedRuns.push(performance.now() - startedAt);
      }

      if (!evaluation) throw new Error("Benchmark did not run");
      const elapsedMeanMs =
        elapsedRuns.reduce((sum, elapsedMs) => sum + elapsedMs, 0) / elapsedRuns.length;
      const bt = evaluation.backtest;
      console.log(
        `[REPLAY_SAFE_BENCH] ${symbol} | timeframe=1H candles=1000 runs=${RUNS_PER_ASSET} meanMs=${elapsedMeanMs.toFixed(1)} setup=${evaluation.setupType} trades=${bt.totalTrades} winRate=${bt.winRate}% expectancy=${bt.expectancy} pf=${bt.profitFactor} maxDD=${bt.maxDrawdown}`,
      );
    });
  }
});
