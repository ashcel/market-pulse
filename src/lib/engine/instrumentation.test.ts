import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { generateMockCandles } from "./mock-candles";
import { evaluateSignal, DEFAULT_RISK_SETTINGS } from "./quant";
import { computeBaseZones } from "./zones";

/**
 * Phase 0/1 inertness regression: the swingStrength / dealingRange /
 * pricePosition (Phase 0) and objectives / anticipatoryPlan (Phase 1) fields
 * are instrumentation only. Every decision-bearing field of `evaluateSignal`
 * must be byte-identical to the snapshot captured at the parent commit,
 * before those fields existed.
 *
 * If this test fails, a supposedly-inert change moved a verdict. Regenerate
 * the snapshot (research/scripts/generate-inertness-snapshots.ts) ONLY for a
 * deliberate, documented verdict-affecting change — never to quiet this test.
 */

interface SnapshotCase {
  case: { symbol: string; timeframe: string; bars: number };
  surface: Record<string, unknown>;
}

const snapshots: SnapshotCase[] = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/inertness-snapshots.json"),
    "utf8",
  ),
);

describe("phase 0 instrumentation is inert", () => {
  it("covers the snapshot universe", () => {
    expect(snapshots.length).toBeGreaterThanOrEqual(6);
  });

  it.each(snapshots.map((s) => [`${s.case.symbol} ${s.case.timeframe}`, s] as const))(
    "%s: decision surface matches the pre-instrumentation snapshot",
    (_label, snapshot) => {
      const { symbol, timeframe, bars } = snapshot.case;
      const candles = generateMockCandles(symbol, timeframe as never, bars);
      const evaluation = evaluateSignal(symbol, candles, computePivots(candles));
      const surface = {
        symbol: evaluation.symbol,
        setupType: evaluation.setupType,
        decision: evaluation.decision,
        direction: evaluation.direction,
        lean: evaluation.lean,
        regime: evaluation.regime,
        confidence: evaluation.confidence,
        components: evaluation.components,
        noTradeReasons: evaluation.noTradeReasons,
        reason: evaluation.reason,
        risk: evaluation.risk,
        analytics: evaluation.analytics,
        backtest: evaluation.backtest,
        strategyVersion: evaluation.strategyVersion,
      };
      expect(surface).toEqual(snapshot.surface);
    },
  );

  it.each(snapshots.map((s) => [`${s.case.symbol} ${s.case.timeframe}`, s.case] as const))(
    "%s: instrumentation fields are populated and internally coherent",
    (_label, snapshotCase) => {
      const { symbol, timeframe, bars } = snapshotCase;
      const candles = generateMockCandles(symbol, timeframe as never, bars);
      const evaluation = evaluateSignal(symbol, candles, computePivots(candles));

      // One strength entry per swing, joined by identity.
      expect(evaluation.swingStrength).toHaveLength(evaluation.structure.swings.length);
      for (const [i, entry] of evaluation.swingStrength.entries()) {
        expect(entry.swing).toBe(evaluation.structure.swings[i]);
      }

      // pricePosition is null exactly when dealingRange is.
      expect(evaluation.pricePosition === null).toBe(evaluation.dealingRange === null);
      if (evaluation.dealingRange) {
        expect(evaluation.dealingRange.low.price).toBeLessThan(evaluation.dealingRange.high.price);
      }
    },
  );

  it.each(snapshots.map((s) => [`${s.case.symbol} ${s.case.timeframe}`, s] as const))(
    "%s: passing zones changes no decision-bearing field and the plan is coherent",
    (_label, snapshot) => {
      const { symbol, timeframe, bars } = snapshot.case;
      const candles = generateMockCandles(symbol, timeframe as never, bars);
      const pivots = computePivots(candles);
      const zones = computeBaseZones(candles);
      const evaluation = evaluateSignal(
        symbol,
        candles,
        pivots,
        DEFAULT_RISK_SETTINGS,
        candles,
        undefined,
        zones,
      );

      // The zones parameter feeds only the anticipatory read: the decision
      // surface still matches the pre-instrumentation snapshot.
      const surface = {
        symbol: evaluation.symbol,
        setupType: evaluation.setupType,
        decision: evaluation.decision,
        direction: evaluation.direction,
        lean: evaluation.lean,
        regime: evaluation.regime,
        confidence: evaluation.confidence,
        components: evaluation.components,
        noTradeReasons: evaluation.noTradeReasons,
        reason: evaluation.reason,
        risk: evaluation.risk,
        analytics: evaluation.analytics,
        backtest: evaluation.backtest,
        strategyVersion: evaluation.strategyVersion,
      };
      expect(surface).toEqual(snapshot.surface);

      // Coherence of the Phase 1 fields.
      const setupDirection =
        evaluation.direction !== "none" ? evaluation.direction : evaluation.lean;
      if (setupDirection === "none") expect(evaluation.objectives).toEqual([]);
      for (const candidate of evaluation.objectives) {
        expect(candidate.direction).toBe(setupDirection);
      }
      for (let i = 1; i < evaluation.objectives.length; i++) {
        const closer =
          setupDirection === "long"
            ? evaluation.objectives[i].price > evaluation.objectives[i - 1].price
            : evaluation.objectives[i].price < evaluation.objectives[i - 1].price;
        expect(closer).toBe(true);
      }
      if (evaluation.objectives.length === 0) {
        expect(evaluation.anticipatoryPlan).toBeNull();
      }
      if (evaluation.anticipatoryPlan) {
        expect(evaluation.anticipatoryPlan.objective).toBe(evaluation.objectives[0]);
        expect(evaluation.anticipatoryPlan.direction).toBe(setupDirection);
        expect(evaluation.anticipatoryPlan.rewardRisk).toBeGreaterThan(0);
      }

      // Zone-less calls (every existing call site outside alignment.ts)
      // simply get no plan — never a wrongly-gated one.
      const withoutZones = evaluateSignal(symbol, candles, pivots);
      expect(withoutZones.anticipatoryPlan).toBeNull();
      expect(withoutZones.objectives.map((c) => c.price)).toEqual(
        evaluation.objectives.map((c) => c.price),
      );
    },
  );
});
