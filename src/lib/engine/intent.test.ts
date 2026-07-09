import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { INTENTS, assessIntent, timeframeBias } from "./intent";
import { computeLiquidityPools } from "./liquidity";
import { generateMockCandles } from "./mock-candles";
import { evaluateSignal } from "./quant";
import { computeMarketStructure } from "./structure";
import type { LiquidityPool } from "./liquidity";
import type { SignalEvaluation } from "./quant";
import type { PivotPoint } from "./types";

/**
 * The intent layer's higher-timeframe context: `timeframeBias` must weigh the
 * swing-structure read alongside the MA regime, and `assessIntent` must
 * consult the context timeframe's intact liquidity pools — a favored call
 * entering straight into one trims to caution; a pool merely en route to
 * target is a note, not a downgrade.
 */

// One real engine evaluation as the stub base — every override below stays a
// structurally complete SignalEvaluation, so gradeLocation and the checklist
// builders run against honest shapes.
const candles = generateMockCandles("BTC", "1H", 200);
const BASE = evaluateSignal("BTC", candles, computePivots(candles));

function stubEval(overrides: Partial<SignalEvaluation>): SignalEvaluation {
  return { ...BASE, components: [], noTradeReasons: [], ...overrides };
}

function biasStub(
  direction: SignalEvaluation["direction"],
  regime: SignalEvaluation["regime"],
  trend: "uptrend" | "downtrend" | "range",
): SignalEvaluation {
  return stubEval({ direction, regime, structure: { ...BASE.structure, trend } });
}

// Real pools built through the real structure engine, at a chosen level.
function bslPoolAt(price: number): LiquidityPool {
  const steps: [PivotPoint["kind"], number][] = [
    ["high", price],
    ["low", price * 0.5],
    ["high", price],
    ["low", price * 0.55],
  ];
  const pools = computeLiquidityPools(
    computeMarketStructure(steps.map(([kind, p], i) => ({ time: i + 1, price: p, kind }))),
  );
  expect(pools[0].side).toBe("bsl");
  expect(pools[0].intact).toBe(true);
  return pools[0];
}

describe("timeframeBias", () => {
  it("returns the setup direction whenever one exists", () => {
    expect(timeframeBias(biasStub("short", "trending-up", "uptrend"))).toBe("short");
  });

  it("leans on the regime when structure is silent", () => {
    expect(timeframeBias(biasStub("none", "trending-up", "range"))).toBe("long");
  });

  it("leans on swing structure when the regime is directionless", () => {
    expect(timeframeBias(biasStub("none", "range-bound", "uptrend"))).toBe("long");
    expect(timeframeBias(biasStub("none", "choppy", "downtrend"))).toBe("short");
  });

  it("returns none when the regime and the swing structure disagree", () => {
    expect(timeframeBias(biasStub("none", "trending-up", "downtrend"))).toBe("none");
    expect(timeframeBias(biasStub("none", "trending-down", "uptrend"))).toBe("none");
  });

  it("agreement between regime and structure keeps the shared lean", () => {
    expect(timeframeBias(biasStub("none", "trending-up", "uptrend"))).toBe("long");
  });
});

describe("assessIntent higher-timeframe liquidity", () => {
  const INTRADAY = INTENTS.find((d) => d.intent === "intraday")!; // context 4H, execution 1H

  // A confirmed 1H long, well located (price hugging support), that reaches
  // "favored" when nothing else intervenes.
  function favoredExecution(): SignalEvaluation {
    return stubEval({
      direction: "long",
      decision: "buy-candidate",
      setupType: "breakout",
      regime: "trending-up",
      confidence: 70,
      analytics: {
        ...BASE.analytics,
        lastClose: 100,
        support: 99,
        resistance: 110,
        atrPercent: 1,
        atr14: 1,
      },
      risk: { ...BASE.risk, direction: "long", entry: 100, target1: 104 },
    });
  }

  function contextWith(liquidity: LiquidityPool[]): SignalEvaluation {
    return stubEval({
      direction: "long",
      regime: "trending-up",
      liquidity,
      analytics: { ...BASE.analytics, atrPercent: 2 }, // proximity window: 1.1%
    });
  }

  function assess(liquidity: LiquidityPool[]) {
    const assessment = assessIntent(INTRADAY, {
      "4H": contextWith(liquidity),
      "1H": favoredExecution(),
    });
    expect(assessment).not.toBeNull();
    return assessment!;
  }

  it("stays favored at full size when the context has no opposing pools", () => {
    const assessment = assess([]);

    expect(assessment.verdict).toBe("favored");
    expect(assessment.sizeMultiplier).toBe(1);
    expect(assessment.checklist.some((c) => c.label.includes("liquidity pool"))).toBe(false);
  });

  it("trims a favored long to caution when entering just below an intact 4H pool", () => {
    // Pool at 100.4 vs entry 100: 0.4% away, inside the 1.1% window.
    const assessment = assess([bslPoolAt(100.4)]);

    expect(assessment.verdict).toBe("caution");
    expect(assessment.sizeMultiplier).toBe(0.5);
    expect(assessment.headline).toContain("liquidity");
    expect(assessment.summary).toContain("100.4");
    const item = assessment.checklist.find((c) => c.label === "No 4H liquidity pool at the entry");
    expect(item).toBeDefined();
    expect(item!.done).toBe(false);
  });

  it("notes a distant pool on the path to target without downgrading", () => {
    // Pool at 103 vs entry 100: 3% away (outside the window) but inside the
    // 104 target — a magnet to expect a reaction at, not a reason to stand down.
    const assessment = assess([bslPoolAt(103)]);

    expect(assessment.verdict).toBe("favored");
    expect(assessment.sizeMultiplier).toBe(1);
    expect(assessment.summary).toContain("103");
    expect(assessment.summary).toContain("magnet");
    const item = assessment.checklist.find((c) => c.label === "No 4H liquidity pool at the entry");
    expect(item).toBeDefined();
    expect(item!.done).toBe(true);
  });

  it("ignores spent pools and pools on the trade's own side", () => {
    const spent = { ...bslPoolAt(100.4), intact: false };
    const ownSide = { ...bslPoolAt(100.4), side: "ssl" as const, price: 99.6 };
    const assessment = assess([spent, ownSide]);

    expect(assessment.verdict).toBe("favored");
    expect(assessment.sizeMultiplier).toBe(1);
  });
});
