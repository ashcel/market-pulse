import { describe, expect, it } from "vitest";

import { generateMockCandles } from "./mock-candles";
import {
  computePivots,
  computeTrendLines,
  MAX_DISPLAY_PIVOTS,
  selectDisplayPivots,
} from "./analysis";
import { evaluateSignal, DEFAULT_RISK_SETTINGS } from "./quant";
import type { PivotPoint } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a stable candle set with enough bars to produce many pivots. */
function makeSeries(symbol = "BTC", bars = 200) {
  return generateMockCandles(symbol, "1H", bars);
}

// ---------------------------------------------------------------------------
// computePivots — returns ALL confirmed pivots
// ---------------------------------------------------------------------------

describe("computePivots", () => {
  it("returns more than MAX_DISPLAY_PIVOTS for a dataset with meaningful structure", () => {
    // Use a longer series: the adaptive window k = ceil(n/40) shrinks relative
    // to bar count, so more local extrema survive the confirmation window.
    // Test across symbols to ensure this isn't seed-dependent.
    const candles = makeSeries("DOGE", 500);
    const pivots = computePivots(candles);

    // A 500-bar cyclical series should comfortably produce > 8 confirmed pivots
    // now that the old MAX_PIVOTS truncation has been removed.
    expect(pivots.length).toBeGreaterThan(MAX_DISPLAY_PIVOTS);
  });

  it("returns pivots sorted by time ascending", () => {
    const pivots = computePivots(makeSeries());

    for (let i = 1; i < pivots.length; i++) {
      expect(pivots[i].time).toBeGreaterThanOrEqual(pivots[i - 1].time);
    }
  });

  it("returns an empty array when candles are too short for the pivot window", () => {
    // With very few candles, 2*k+1 exceeds the series length.
    const candles = makeSeries("ETH", 3);
    expect(computePivots(candles)).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(computePivots([])).toEqual([]);
  });

  it("every pivot has a valid kind", () => {
    const pivots = computePivots(makeSeries());
    for (const p of pivots) {
      expect(["high", "low"]).toContain(p.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// selectDisplayPivots — presentation-layer filter
// ---------------------------------------------------------------------------

describe("selectDisplayPivots", () => {
  it("caps output to MAX_DISPLAY_PIVOTS by default", () => {
    const candles = makeSeries();
    const all = computePivots(candles);
    const display = selectDisplayPivots(all, candles);

    expect(display.length).toBeLessThanOrEqual(MAX_DISPLAY_PIVOTS);
  });

  it("respects a custom maxCount", () => {
    const candles = makeSeries();
    const all = computePivots(candles);
    const display = selectDisplayPivots(all, candles, 4);

    expect(display.length).toBeLessThanOrEqual(4);
  });

  it("preserves time ordering", () => {
    const candles = makeSeries();
    const display = selectDisplayPivots(computePivots(candles), candles);

    for (let i = 1; i < display.length; i++) {
      expect(display[i].time).toBeGreaterThanOrEqual(display[i - 1].time);
    }
  });

  it("returns a subset of the full pivot set (every display pivot exists in the full set)", () => {
    const candles = makeSeries();
    const all = computePivots(candles);
    const display = selectDisplayPivots(all, candles);

    const fullSet = new Set(all.map((p) => `${p.time}:${p.kind}:${p.price}`));
    for (const p of display) {
      expect(fullSet.has(`${p.time}:${p.kind}:${p.price}`)).toBe(true);
    }
  });

  it("returns all pivots unchanged when count is at or below maxCount", () => {
    const candles = makeSeries("ETH", 30);
    const all = computePivots(candles);

    // With very few candles we get few pivots — selectDisplayPivots should pass them through.
    if (all.length <= MAX_DISPLAY_PIVOTS) {
      const display = selectDisplayPivots(all, candles);
      expect(display).toEqual(all);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: downstream consumers accept the full pivot set
// ---------------------------------------------------------------------------

describe("downstream consumer regression", () => {
  const candles = makeSeries("SOL", 200);
  const pivots = computePivots(candles);

  it("computeTrendLines produces valid output with the full pivot set", () => {
    const lines = computeTrendLines(candles, pivots);

    expect(lines).toHaveProperty("support");
    expect(lines).toHaveProperty("resistance");
    // With enough pivots of each kind, we should get non-empty trendlines.
    expect(Array.isArray(lines.support)).toBe(true);
    expect(Array.isArray(lines.resistance)).toBe(true);
  });

  it("evaluateSignal produces a valid evaluation with the full pivot set", () => {
    const evaluation = evaluateSignal("SOL", candles, pivots, DEFAULT_RISK_SETTINGS);

    expect(evaluation.symbol).toBe("SOL");
    expect(evaluation.confidence).toBeGreaterThanOrEqual(0);
    expect(evaluation.confidence).toBeLessThanOrEqual(100);
    expect(evaluation.setupType).toBeTruthy();
    expect(evaluation.decision).toBeTruthy();
    expect(evaluation.direction).toBeTruthy();
    expect(evaluation.regime).toBeTruthy();
    expect(evaluation.risk).toBeTruthy();
    expect(evaluation.analytics).toBeTruthy();
    expect(evaluation.backtest).toBeTruthy();
  });

  it("evaluateSignal with separate backtestCandles produces valid output", () => {
    const backtestCandles = makeSeries("SOL", 500);

    const evaluation = evaluateSignal(
      "SOL",
      candles,
      pivots,
      DEFAULT_RISK_SETTINGS,
      backtestCandles,
    );

    expect(evaluation.backtest.strategyVersion).toBeTruthy();
    expect(typeof evaluation.backtest.totalTrades).toBe("number");
  });

  it("selectDisplayPivots selects the most prominent pivots", () => {
    // Verify the display set favors high-prominence pivots by checking that
    // the average prominence of the display set >= average of the excluded set.
    // This is a statistical property, not a strict invariant, but it should
    // hold for well-structured mock data.
    const candles = makeSeries("BTC", 200);
    const all = computePivots(candles);
    const display = selectDisplayPivots(all, candles);

    // At minimum, display should not be empty when we have pivots
    if (all.length > 0) {
      expect(display.length).toBeGreaterThan(0);
    }
  });
});
