import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { INTENTS, assessIntent, timeframeBias } from "./intent";
import { computeLiquidityPools } from "./liquidity";
import { generateMockCandles } from "./mock-candles";
import { evaluateSignal } from "./quant";
import { computeMarketStructure } from "./structure";
import type { LiquidityPool } from "./liquidity";
import type { ObjectiveCandidate } from "./objectives";
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
  // Null the event so the structural lean is the trend alone — the mock-data
  // base evaluation may carry a live BOS/CHoCH that would color range cases.
  return stubEval({
    direction,
    regime,
    structure: { ...BASE.structure, trend, event: null, eventSwing: null },
  });
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
  it("returns the setup direction when nothing contradicts it", () => {
    expect(timeframeBias(biasStub("short", "trending-down", "downtrend"))).toBe("short");
    expect(timeframeBias(biasStub("long", "range-bound", "range"))).toBe("long");
  });

  it("suppresses a setup direction the engine vetoes and falls back to the trend read", () => {
    // The UNI case: a failed-breakout short printed inside a confirmed
    // uptrend. The engine refuses that trade, so the lean must not be short —
    // regime and structure agree up, and that agreement is the lean.
    expect(timeframeBias(biasStub("short", "trending-up", "uptrend"))).toBe("long");
    expect(timeframeBias(biasStub("short", "range-bound", "uptrend"))).toBe("long");
    expect(timeframeBias(biasStub("long", "trending-down", "range"))).toBe("short");
  });

  it("returns none when a vetoed setup leaves regime and structure in conflict", () => {
    expect(timeframeBias(biasStub("long", "trending-up", "downtrend"))).toBe("none");
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
      // Structure must agree with the long — a structure that fights it would
      // (correctly) suppress the timeframe's lean and void the setup.
      structure: { ...BASE.structure, trend: "uptrend", event: null, eventSwing: null },
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
      structure: { ...BASE.structure, trend: "uptrend", event: null, eventSwing: null },
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

describe("assessIntent phase 1 overlay (objectives + anticipatory plan)", () => {
  const INTRADAY = INTENTS.find((d) => d.intent === "intraday")!; // context 4H, execution 1H

  // Reuses the favored-long harness above: entry 100, confirmed 1H long.
  function favoredExecution(overrides: Partial<SignalEvaluation> = {}): SignalEvaluation {
    return stubEval({
      direction: "long",
      decision: "buy-candidate",
      setupType: "breakout",
      regime: "trending-up",
      structure: { ...BASE.structure, trend: "uptrend", event: null, eventSwing: null },
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
      ...overrides,
    });
  }

  function context(): SignalEvaluation {
    return stubEval({
      direction: "long",
      regime: "trending-up",
      structure: { ...BASE.structure, trend: "uptrend", event: null, eventSwing: null },
      liquidity: [],
      analytics: { ...BASE.analytics, atrPercent: 2 },
    });
  }

  // A long objective candidate at a chosen level, direction-tagged.
  function candidateAt(price: number, direction: "long" | "short" = "long"): ObjectiveCandidate {
    return {
      direction,
      swing: {
        kind: direction === "long" ? "high" : "low",
        price,
        time: 42,
        label: null,
        event: null,
        equal: null,
      },
      strength: "weak",
      price,
      pool: null,
    };
  }

  it("is verdict-inert: stripping the phase 1 fields changes no verdict, size, or plan", () => {
    // The same assessment computed from evaluations with and without the
    // surfaced reads must agree on every decision-bearing field — the
    // overlay only explains, never decides.
    const cases: Array<Partial<Record<"4H" | "1H", SignalEvaluation>>> = [
      { "4H": context(), "1H": favoredExecution() },
      {
        "4H": context(),
        "1H": favoredExecution({
          objectives: [candidateAt(108)],
          anticipatoryPlan: {
            direction: "long",
            zone: {
              kind: "demand",
              priceLow: 96,
              priceHigh: 98,
              startTime: 1,
              endTime: 2,
              freshness: "fresh",
            },
            entry: 98,
            stop: 96,
            objective: candidateAt(108),
            riskPerUnit: 2,
            rewardPerUnit: 10,
            rewardRisk: 5,
            entryPosition: "discount",
          },
        }),
      },
    ];
    for (const evals of cases) {
      const withReads = assessIntent(INTRADAY, evals)!;
      const stripped = assessIntent(INTRADAY, {
        "4H": { ...evals["4H"]!, objectives: [], anticipatoryPlan: null },
        "1H": { ...evals["1H"]!, objectives: [], anticipatoryPlan: null },
      })!;
      expect(withReads.verdict).toBe(stripped.verdict);
      expect(withReads.sizeMultiplier).toBe(stripped.sizeMultiplier);
      expect(withReads.plan).toEqual(stripped.plan);
      expect(withReads.headline).toBe(stripped.headline);
      expect(withReads.summary).toBe(stripped.summary);
      expect(withReads.triggers).toEqual(stripped.triggers);
    }
  });

  it("adds the objective checklist item — done with a draw, naming level, strength, and depth", () => {
    const assessment = assessIntent(INTRADAY, {
      "4H": context(),
      "1H": favoredExecution({ objectives: [candidateAt(108), candidateAt(112)] }),
    })!;
    const item = assessment.checklist.find((c) => c.label === "Clean liquidity objective exists");
    expect(item).toBeDefined();
    expect(item!.done).toBe(true);
    expect(item!.detail).toContain("108");
    expect(item!.detail).toContain("weak");
    expect(item!.detail).toContain("1 further draw");
  });

  it("marks the objective item not-done when no draw exists (G10 displayed, not enforced)", () => {
    // The stub's structure comes from real mock data whose objectives resolve
    // through the real resolver — force the empty case by matching direction
    // with an empty list AND a structure whose highs are all taken/strong.
    const exe = favoredExecution({ objectives: [] });
    // Direction long with exe.objectives[0] undefined → re-resolution runs on
    // exe.structure/liquidity; use a bare structure with nothing above 100.
    exe.structure = {
      ...BASE.structure,
      swings: [],
      trend: "uptrend",
      event: null,
      eventSwing: null,
      lastHigh: null,
      lastLow: null,
      equalHighs: [],
      equalLows: [],
    };
    exe.liquidity = [];
    const assessment = assessIntent(INTRADAY, { "4H": context(), "1H": exe })!;
    const item = assessment.checklist.find((c) => c.label === "Clean liquidity objective exists");
    expect(item).toBeDefined();
    expect(item!.done).toBe(false);
    expect(assessment.verdict).toBe("favored"); // still favored — no veto
    expect(assessment.anticipatoryPlan).toBeNull();
  });

  it("surfaces the execution plan when its direction matches, and gates done on ctx discount", () => {
    const plan = {
      direction: "long" as const,
      zone: {
        kind: "demand" as const,
        priceLow: 96,
        priceHigh: 98,
        startTime: 1,
        endTime: 2,
        freshness: "fresh" as const,
      },
      entry: 98,
      stop: 96,
      objective: candidateAt(108),
      riskPerUnit: 2,
      rewardPerUnit: 10,
      rewardRisk: 5,
      entryPosition: "discount" as const,
    };
    const assessment = assessIntent(INTRADAY, {
      "4H": context(),
      "1H": favoredExecution({ objectives: [candidateAt(108)], anticipatoryPlan: plan }),
    })!;
    expect(assessment.anticipatoryPlan).toBe(plan);
    const item = assessment.checklist.find((c) => c.label.startsWith("Limit entry at a POI"));
    expect(item).toBeDefined();
    // The 4H context stub carries mock-data structure; done is whatever the
    // real classifyPrice says — assert the detail stays coherent with it.
    if (item!.done) {
      expect(item!.detail).toContain("98");
      expect(item!.detail).toContain("discount");
    } else {
      expect(item!.detail.length).toBeGreaterThan(0);
    }
  });

  it("adds neither item when the assessment stands aside", () => {
    const flat = stubEval({
      direction: "none",
      regime: "range-bound",
      structure: { ...BASE.structure, trend: "range", event: null, eventSwing: null },
    });
    const assessment = assessIntent(INTRADAY, { "4H": flat, "1H": flat })!;
    expect(assessment.direction).toBe("none");
    expect(
      assessment.checklist.some(
        (c) => c.label === "Clean liquidity objective exists" || c.label.startsWith("Limit entry"),
      ),
    ).toBe(false);
    expect(assessment.anticipatoryPlan).toBeNull();
  });
});
