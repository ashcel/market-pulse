import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { CRYPTO_RISK_SETTINGS } from "./crypto-config";
import { generateMockCandles } from "./mock-candles";
import {
  analyticsFor,
  buildRiskPlan,
  DEFAULT_RISK_SETTINGS,
  evaluateSignal,
  type RiskSettings,
} from "./quant";
import type { Candle, PivotPoint } from "./types";

// ---------------------------------------------------------------------------
// Regression tests for the defended swing stop (see
// docs/decisions/0001-defended-swing-stop.md and sr-candidates.test.ts for the
// evidence that motivated it). The "swing" stop method anchors on the
// alternation-collapsed leg extreme — the level the market defended — instead
// of the nearest raw pivot, which can be an interior touch of one leg. The
// change is confined to buildRiskPlan's swing branch: raw levels still drive
// targets, the entry zone, analytics, and every proximity consumer.
// ---------------------------------------------------------------------------

const STEP = 3600;
const T0 = 1_700_000_000;

function bar(i: number, high: number, low: number, close = (high + low) / 2): Candle {
  return { time: T0 + i * STEP, open: close, high, low, close, volume: 1000 };
}

/**
 * Flat series with a controlled close: every bar spans close ± 0.1, so
 * atr14 = 0.2 and the swing branch's ATR floor sits at entry ∓ 0.14.
 */
function flatSeries(bars: number, close: number): Candle[] {
  return Array.from({ length: bars }, (_, i) => bar(i, close + 0.1, close - 0.1, close));
}

function handPivots(...steps: [PivotPoint["kind"], number][]): PivotPoint[] {
  return steps.map(([kind, price], i) => ({ time: T0 + (i + 1) * STEP, price, kind }));
}

const SWING: RiskSettings = { ...DEFAULT_RISK_SETTINGS, stopMethod: "swing" };

describe("buildRiskPlan defended swing stop", () => {
  // Scenario D from sr-candidates.test.ts: lows print 50 → 48 → 52 with no
  // confirmed high between — one down-leg whose newest touch (52) is interior.
  const legRunLows = handPivots(["low", 50], ["low", 48], ["low", 52]);

  it("anchors a long swing stop at the defended leg extreme, not the interior touch", () => {
    const candles = flatSeries(30, 53);
    const plan = buildRiskPlan(candles, legRunLows, "long", SWING);

    // Old behavior stopped at 52 (nearest raw low — a wick-out magnet).
    // The defended level for this leg is its extreme, 48.
    expect(plan.stop).toBe(48);
    expect(plan.invalidation).toBe(48);
  });

  it("anchors a short swing stop at the defended leg extreme above, not the interior touch", () => {
    const candles = flatSeries(30, 46);
    const highRun = handPivots(["high", 50], ["high", 52], ["high", 48]);
    const plan = buildRiskPlan(candles, highRun, "short", SWING);

    // Nearest raw high above 46 is the interior 48; the leg extreme is 52.
    expect(plan.stop).toBe(52);
  });

  it("keeps the ATR floor binding when the defended level hugs entry", () => {
    const candles = flatSeries(30, 53);
    const hugging = handPivots(["low", 52.95], ["low", 52.9]);
    const plan = buildRiskPlan(candles, hugging, "long", SWING);

    // Both the raw (52.95) and defended (52.9) levels sit above the
    // entry − 0.7·ATR floor (52.86), so the floor wins — exactly as before.
    expect(plan.stop).toBe(52.86);
  });

  it("is a no-op on cleanly alternating structure", () => {
    const candles = flatSeries(30, 53);
    const alternating = handPivots(["low", 50], ["high", 55], ["low", 51], ["high", 56]);
    const plan = buildRiskPlan(candles, alternating, "long", SWING);

    // Alternating pivots pass through toAlternatingSwings unchanged, so the
    // defended support equals the raw support (51).
    expect(plan.stop).toBe(51);
  });

  it("leaves atr and fixed-percent stops untouched by pivot geometry", () => {
    const candles = flatSeries(30, 53);
    const atrPlan = buildRiskPlan(candles, legRunLows, "long", {
      ...DEFAULT_RISK_SETTINGS,
      stopMethod: "atr",
    });
    const fixedPlan = buildRiskPlan(candles, legRunLows, "long", {
      ...DEFAULT_RISK_SETTINGS,
      stopMethod: "fixed-percent",
    });

    // entry − atr14 · 1.5 and entry · (1 − 2%): pure formulas, no levels.
    expect(atrPlan.stop).toBe(52.7);
    expect(fixedPlan.stop).toBe(51.94);
  });

  it("is deterministic: identical inputs produce identical plans", () => {
    const candles = flatSeries(30, 53);
    const first = buildRiskPlan(candles, legRunLows, "long", SWING);
    const second = buildRiskPlan(candles, legRunLows, "long", SWING);

    expect(second).toEqual(first);
  });

  it("property: on realistic series the swing stop never tightens, sizing honors the risk budget, and R:R keeps its floor", () => {
    for (const symbol of ["BTC", "ETH", "SOL", "DOGE", "PEPE"]) {
      const candles = generateMockCandles(symbol, "1H", 500);
      const pivots = computePivots(candles);
      const analytics = analyticsFor(candles, pivots);
      const crypto: RiskSettings = { ...CRYPTO_RISK_SETTINGS, stopMethod: "swing" };

      for (const direction of ["long", "short"] as const) {
        const plan = buildRiskPlan(candles, pivots, direction, crypto);

        // Subset invariant: the defended level is never nearer than the raw
        // level, so the stop can only sit at or beyond where the raw-anchored
        // stop would have (tolerance covers roundPrice on both sides).
        if (direction === "long" && analytics.support !== null) {
          const eps = Math.max(1e-6, analytics.support * 1e-4);
          expect(plan.stop).toBeLessThanOrEqual(analytics.support + eps);
        }
        if (direction === "short" && analytics.resistance !== null) {
          const eps = Math.max(1e-6, analytics.resistance * 1e-4);
          expect(plan.stop).toBeGreaterThanOrEqual(analytics.resistance - eps);
        }

        // Dollar risk is invariant under stop width: wider stops shrink size,
        // not the risk budget.
        expect(plan.riskPerUnit).toBeGreaterThan(0);
        expect(Math.abs(plan.maxDollarLoss - plan.maxDollarRisk)).toBeLessThanOrEqual(
          plan.maxDollarRisk * 0.01,
        );

        // target1 = max(resistance, entry + 1.8·risk) floors reward/risk at
        // 1.8 regardless of stop width — the mechanism that keeps this change
        // from flipping any decision at shipped settings.
        expect(plan.rewardRisk1).toBeGreaterThanOrEqual(1.8);
      }

      // Decision-invariance mechanism, asserted end-to-end: at shipped crypto
      // settings the R:R gate can never be the blocker, whatever the stop.
      const evaluation = evaluateSignal(symbol, candles, pivots, CRYPTO_RISK_SETTINGS);
      expect(evaluation.noTradeReasons).not.toContain(
        "Reward/risk is below the configured minimum.",
      );
    }
  });
});
