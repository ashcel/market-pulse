import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { reconcileHolds } from "./hysteresis";
import { INTENTS, assessIntent } from "./intent";
import { generateMockCandles } from "./mock-candles";
import { evaluateSignal } from "./quant";
import {
  MIN_SHADOW_RECORD_TRADES,
  applyRecordAdjustment,
  buildShadowSignal,
  type ShadowComboStat,
} from "./shadow";
import type { SignalEvaluation } from "./quant";

/**
 * P2.2 boundary proof (2026-07-12), pinned as regression tests. The question:
 * does the combo-stats demotion change WHAT the forward test records? Answer,
 * in three parts — and any PR that flips one of these expectations is
 * changing record semantics and must bump ENGINE_VERSION behind a
 * pre-registered spike:
 *
 * 1. The shadow-open gate is demotion-independent: `reconcileHolds` pushes
 *    into `openedFavored` on `favoredBeforeAdjustment` (the RAW verdict), so
 *    a demoted call still opens its record — the record never self-censors
 *    its own evidence stream.
 * 2. The opened record's content is demotion-independent: demotion halves
 *    only sizing fields (`scalePlan`) and `buildShadowSignal` persists only
 *    prices/confidence/classification, so the persisted row is identical
 *    with or without the demotion.
 * 3. KNOWN second-order coupling: the *hold* captures the post-adjustment
 *    verdict ("caution", rank 2, not "favored", rank 3), and hold rank feeds
 *    the upgrade-release rule — so the demotion statistic shapes WHEN future
 *    holds release and therefore the timing of future opens. This is why a
 *    change to the demotion statistic (e.g. hierarchical shrinkage) is
 *    version-sensitive even though (1) and (2) are clean.
 */

const INTRADAY = INTENTS.find((d) => d.intent === "intraday")!;
const candles = generateMockCandles("BTC", "1H", 200);
const BASE = evaluateSignal("BTC", candles, computePivots(candles));

function favoredAssessment() {
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
    objectives: [],
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

/** A proven-negative record for exactly this assessment's combo. */
const DEMOTED_COMBO: ShadowComboStat = {
  setupType: "breakout",
  regime: "trending-up",
  closed: MIN_SHADOW_RECORD_TRADES,
  winRate: 20,
  averageR: -0.4,
  demoted: true,
};

const NOW_MS = Date.parse("2026-07-12T00:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();

describe("record boundary: demotion vs what gets recorded (P2.2)", () => {
  it("a demoted favored call still opens a shadow record (gate reads the raw verdict)", () => {
    const entry = applyRecordAdjustment(favoredAssessment(), [DEMOTED_COMBO]);
    expect(entry.assessment.verdict).toBe("caution"); // demotion applied to display
    expect(entry.favoredBeforeAdjustment).toBe(true); // ...but the raw verdict is remembered

    const result = reconcileHolds({
      symbol: "BTC",
      market: "spot",
      entries: [entry],
      holds: {},
      nowMs: NOW_MS,
    });
    expect(result.openedFavored).toHaveLength(1);
  });

  it("the opened record is byte-identical with and without the demotion", () => {
    const demoted = applyRecordAdjustment(favoredAssessment(), [DEMOTED_COMBO]);
    const clean = applyRecordAdjustment(favoredAssessment(), []);

    const openDemoted = reconcileHolds({
      symbol: "BTC",
      market: "spot",
      entries: [demoted],
      holds: {},
      nowMs: NOW_MS,
    }).openedFavored[0];
    const openClean = reconcileHolds({
      symbol: "BTC",
      market: "spot",
      entries: [clean],
      holds: {},
      nowMs: NOW_MS,
    }).openedFavored[0];

    expect(buildShadowSignal(openDemoted, "BTC", "spot", NOW_ISO)).toEqual(
      buildShadowSignal(openClean, "BTC", "spot", NOW_ISO),
    );
  });

  it("KNOWN coupling: the hold captures the post-demotion verdict, so demotion shapes future release timing", () => {
    const demoted = applyRecordAdjustment(favoredAssessment(), [DEMOTED_COMBO]);
    const clean = applyRecordAdjustment(favoredAssessment(), []);

    const holdDemoted = Object.values(
      reconcileHolds({
        symbol: "BTC",
        market: "spot",
        entries: [demoted],
        holds: {},
        nowMs: NOW_MS,
      }).updates,
    )[0];
    const holdClean = Object.values(
      reconcileHolds({ symbol: "BTC", market: "spot", entries: [clean], holds: {}, nowMs: NOW_MS })
        .updates,
    )[0];

    // This asymmetry is the second-order path: caution (rank 2) releases to a
    // later favored read, favored (rank 3) does not. Changing the demotion
    // statistic therefore changes open cadence → version-sensitive.
    expect(holdDemoted.verdict).toBe("caution");
    expect(holdDemoted.sizeMultiplier).toBe(0.5);
    expect(holdClean.verdict).toBe("favored");
    expect(holdClean.sizeMultiplier).toBe(1);
  });
});
