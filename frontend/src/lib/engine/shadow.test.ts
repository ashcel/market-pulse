import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { INTENTS, assessIntent } from "./intent";
import { generateMockCandles } from "./mock-candles";
import { evaluateSignal } from "./quant";
import { buildShadowSignal, settleShadowSignal, type ShadowSignal } from "./shadow";
import type { SignalEvaluation } from "./quant";

/**
 * The Phase 1 shadow annotation: `objectiveResolved` tags every new record
 * with whether a clean draw-on-liquidity objective existed at adoption, so
 * the post-0.5 analysis can split cohorts. It must key nothing and must not
 * disturb settlement of records that predate it.
 */

const INTRADAY = INTENTS.find((d) => d.intent === "intraday")!;
const candles = generateMockCandles("BTC", "1H", 200);
const BASE = evaluateSignal("BTC", candles, computePivots(candles));

function favoredAssessment(objectives: SignalEvaluation["objectives"]) {
  const execution: SignalEvaluation = {
    ...BASE,
    components: [],
    noTradeReasons: [],
    direction: "long",
    decision: "buy-candidate",
    setupType: "breakout",
    regime: "trending-up",
    structure: { ...BASE.structure, trend: "uptrend", event: null, eventSwing: null },
    confidence: 70,
    analytics: { ...BASE.analytics, lastClose: 100, support: 99, resistance: 110 },
    risk: { ...BASE.risk, direction: "long", entry: 100, stop: 98, target1: 104, target2: 108 },
    objectives,
    anticipatoryPlan: null,
  };
  const context: SignalEvaluation = {
    ...BASE,
    components: [],
    noTradeReasons: [],
    direction: "long",
    regime: "trending-up",
    structure: { ...BASE.structure, trend: "uptrend", event: null, eventSwing: null },
    liquidity: [],
  };
  const assessment = assessIntent(INTRADAY, { "4H": context, "1H": execution })!;
  expect(assessment.verdict).toBe("favored");
  return assessment;
}

describe("buildShadowSignal objectiveResolved", () => {
  it("tags a record true when the execution evaluation resolved objectives", () => {
    const assessment = favoredAssessment([
      {
        direction: "long",
        swing: { kind: "high", price: 108, time: 42, label: null, event: null, equal: null },
        strength: "weak",
        price: 108,
        pool: null,
      },
    ]);
    const input = buildShadowSignal(assessment, "btc", "spot", "2026-07-10T00:00:00.000Z");
    expect(input).not.toBeNull();
    expect(input!.objectiveResolved).toBe(true);
    // The keyed fields are untouched by the annotation.
    expect(input!.setupType).toBe("breakout");
    expect(input!.regime).toBe("trending-up");
  });

  it("tags a record false when no clean objective existed", () => {
    const input = buildShadowSignal(
      favoredAssessment([]),
      "btc",
      "spot",
      "2026-07-10T00:00:00.000Z",
    );
    expect(input!.objectiveResolved).toBe(false);
  });
});

describe("settleShadowSignal with pre-annotation records", () => {
  it("settles an old record that has no objectiveResolved field", () => {
    // A persisted record from before Phase 1 — the optional field is absent.
    const signal: ShadowSignal = {
      id: "legacy-1",
      symbol: "BTC",
      market: "spot",
      intent: "intraday",
      direction: "long",
      setupType: "breakout",
      regime: "trending-up",
      timeframe: "1H",
      entry: 100,
      stop: 98,
      target1: 104,
      target2: 108,
      confidence: 70,
      openedAt: "2026-07-10T00:00:00.000Z",
      status: "active",
    };
    const opened = Date.parse(signal.openedAt) / 1000;
    const bars = [{ time: opened + 3600, open: 100, high: 105, low: 100, close: 104.5, volume: 1 }];
    const patch = settleShadowSignal(signal, bars);
    expect(patch).not.toBeNull();
    expect(patch!.status).toBe("target1-hit");
  });
});
