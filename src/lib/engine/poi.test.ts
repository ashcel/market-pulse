import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { computeDealingRange, type DealingRange } from "./equilibrium";
import { computeLiquidityPools } from "./liquidity";
import { generateMockCandles } from "./mock-candles";
import { resolveObjectives, type ObjectiveCandidate } from "./objectives";
import { buildAnticipatoryPlan, selectPoi } from "./poi";
import { computeMarketStructure } from "./structure";
import type { PivotPoint } from "./types";
import { computeBaseZones, type BaseZone } from "./zones";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

function pivot(kind: "high" | "low", price: number, time: number): PivotPoint {
  return { kind, price, time };
}

function zone(
  kind: "demand" | "supply",
  priceLow: number,
  priceHigh: number,
  freshness: BaseZone["freshness"] = "fresh",
  startTime = 1,
): BaseZone {
  return { kind, priceLow, priceHigh, startTime, endTime: startTime + 1, freshness };
}

/** A range whose equilibrium is the midpoint of [low, high] — swings are stubs. */
function rangeAt(low: number, high: number): DealingRange {
  const swing = (kind: "high" | "low", price: number) => ({
    kind,
    price,
    time: 1,
    label: null,
    event: null,
    equal: null,
  });
  return {
    low: swing("low", low),
    high: swing("high", high),
    anchor: "low",
    equilibrium: (low + high) / 2,
  };
}

function objectiveAt(price: number, direction: "long" | "short" = "long"): ObjectiveCandidate {
  return {
    direction,
    swing: {
      kind: direction === "long" ? "high" : "low",
      price,
      time: 9,
      label: null,
      event: null,
      equal: null,
    },
    strength: "weak",
    price,
    pool: null,
  };
}

describe("selectPoi", () => {
  const range = rangeAt(100, 200); // equilibrium 150

  it("prefers a discount-side demand zone over a nearer premium-side one for longs", () => {
    const premium = zone("demand", 155, 160, "fresh");
    const discount = zone("demand", 110, 120, "fresh");
    expect(selectPoi([premium, discount], "long", 170, range)).toBe(discount);
  });

  it("prefers fresh over tested, then the nearest proximal edge", () => {
    const tested = zone("demand", 130, 140, "tested");
    const fresh = zone("demand", 110, 120, "fresh");
    expect(selectPoi([tested, fresh], "long", 170, range)).toBe(fresh);

    const near = zone("demand", 125, 135, "fresh");
    const far = zone("demand", 105, 115, "fresh");
    expect(selectPoi([near, far], "long", 170, range)).toBe(near);
  });

  it("only considers zones the pullback can reach — proximal edge at/below fromPrice for longs", () => {
    const above = zone("demand", 172, 180, "fresh");
    expect(selectPoi([above], "long", 170, range)).toBeNull();
    const at = zone("demand", 160, 170, "fresh");
    expect(selectPoi([at], "long", 170, range)).toBe(at);
  });

  it("mirrors for shorts: supply zones above, premium side preferred", () => {
    const discount = zone("supply", 140, 145, "fresh");
    const premium = zone("supply", 180, 190, "fresh");
    expect(selectPoi([discount, premium], "short", 130, range)).toBe(premium);
    expect(selectPoi([zone("demand", 180, 190, "fresh")], "short", 130, range)).toBeNull();
  });

  it("skips the position filter when no dealing range exists", () => {
    const near = zone("demand", 155, 160, "fresh");
    const far = zone("demand", 110, 120, "fresh");
    expect(selectPoi([near, far], "long", 170, null)).toBe(near);
  });
});

describe("buildAnticipatoryPlan", () => {
  const range = rangeAt(100, 200);
  const demand = zone("demand", 110, 120, "fresh");

  it("derives entry at the proximal edge, stop at the distal edge, RR from the limit price", () => {
    const plan = buildAnticipatoryPlan([demand], "long", 170, range, [objectiveAt(180)]);
    expect(plan).not.toBeNull();
    expect(plan!.entry).toBe(120);
    expect(plan!.stop).toBe(110);
    expect(plan!.riskPerUnit).toBe(10);
    // Reward measured from the limit (120), not fromPrice (170).
    expect(plan!.rewardPerUnit).toBe(60);
    expect(plan!.rewardRisk).toBe(6);
    expect(plan!.objective.price).toBe(180);
    expect(plan!.entryPosition).toBe("discount");
  });

  it("mirrors for shorts", () => {
    const supply = zone("supply", 180, 190, "fresh");
    const plan = buildAnticipatoryPlan([supply], "short", 130, range, [objectiveAt(120, "short")]);
    expect(plan).not.toBeNull();
    expect(plan!.entry).toBe(180);
    expect(plan!.stop).toBe(190);
    expect(plan!.rewardPerUnit).toBe(60);
    expect(plan!.entryPosition).toBe("premium");
  });

  it("targets the preferred candidate — objectives[0] — not a deeper one", () => {
    const plan = buildAnticipatoryPlan([demand], "long", 170, range, [
      objectiveAt(180),
      objectiveAt(195),
    ]);
    expect(plan!.objective.price).toBe(180);
  });

  it("returns null with no objective — no clean target, no plan (G10's shape)", () => {
    expect(buildAnticipatoryPlan([demand], "long", 170, range, [])).toBeNull();
  });

  it("returns null with no qualifying zone", () => {
    expect(buildAnticipatoryPlan([], "long", 170, range, [objectiveAt(180)])).toBeNull();
  });

  it("returns null on degenerate geometry — objective at or below the limit entry", () => {
    expect(buildAnticipatoryPlan([demand], "long", 170, range, [objectiveAt(120)])).toBeNull();
    expect(buildAnticipatoryPlan([demand], "long", 170, range, [objectiveAt(115)])).toBeNull();
  });

  it("records entryPosition null when no range exists, without vetoing the plan", () => {
    const plan = buildAnticipatoryPlan([demand], "long", 170, null, [objectiveAt(180)]);
    expect(plan).not.toBeNull();
    expect(plan!.entryPosition).toBeNull();
  });

  it("is deterministic and replay-safe over prefix windows", () => {
    for (const symbol of ["BTC", "ETH"]) {
      const candles = generateMockCandles(symbol, "4H", 360);
      for (let n = 60; n <= candles.length; n += 30) {
        const window = candles.slice(0, n);
        const structure = computeMarketStructure(computePivots(window));
        const pools = computeLiquidityPools(structure);
        const rng = computeDealingRange(structure);
        const zones = computeBaseZones(window);
        const from = window[window.length - 1].close;
        for (const direction of ["long", "short"] as const) {
          const objectives = resolveObjectives(structure, pools, direction, from);
          const plan = buildAnticipatoryPlan(zones, direction, from, rng, objectives);
          expect(buildAnticipatoryPlan(zones, direction, from, rng, objectives)).toEqual(plan);
          if (plan) {
            // Nothing in the plan can postdate the window; geometry holds.
            expect(plan.zone.endTime).toBeLessThanOrEqual(window[window.length - 1].time);
            expect(plan.objective.swing.time).toBeLessThanOrEqual(window[window.length - 1].time);
            expect(plan.rewardRisk).toBeGreaterThan(0);
            const ordered =
              direction === "long"
                ? plan.stop < plan.entry && plan.entry < plan.objective.price
                : plan.objective.price < plan.entry && plan.entry < plan.stop;
            expect(ordered).toBe(true);
          }
        }
      }
    }
  });
});

describe("dreimann annotation fidelity — POI + stop", () => {
  // Logic correctness only (R5). Zones are built on the 4h context candles —
  // where Dreimann draws his boxes; SD_ZONE_TIMEFRAMES gates 15m anyway.

  function contextAtEntry(name: (typeof DREIMANN_TRADES)[number]) {
    const fixture = loadDreimannFixture(name);
    const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
    const context = fixture.series["4h"]!.filter((c) => c.time <= entryTime);
    const structure = computeMarketStructure(computePivots(context));
    return {
      fixture,
      zones: computeBaseZones(context),
      range: computeDealingRange(structure),
      structure,
      pools: computeLiquidityPools(structure),
    };
  }

  it("zec-sl: the derived stop sits at or below the trader's swept stop (454.73)", () => {
    // The instructive loss: his stop sat inside the POI's liquidity noise and
    // was wicked out before the objective printed. Ours must rest outside
    // that noise — at or below the level that took his.
    const { fixture, zones, range, structure, pools } = contextAtEntry("zec-sl");
    const objectives = resolveObjectives(structure, pools, "long", fixture.labels.entry.price);
    const plan = buildAnticipatoryPlan(
      zones,
      "long",
      fixture.labels.entry.price,
      range,
      objectives,
    );
    expect(plan).not.toBeNull();
    expect(plan!.stop).toBeLessThanOrEqual(454.73);
    expect(plan!.stop).toBeLessThan(plan!.entry);
  });

  it.each(DREIMANN_TRADES)(
    "%s: when a qualifying 4h zone exists, the plan is coherent as-of entry (absence recorded, not failed)",
    (name) => {
      const { fixture, zones, range, structure, pools } = contextAtEntry(name);
      const entryPrice = fixture.labels.entry.price;
      const objectives = resolveObjectives(structure, pools, "long", entryPrice);
      const plan = buildAnticipatoryPlan(zones, "long", entryPrice, range, objectives);
      if (!plan) {
        // Finding, not failure: no qualifying demand zone (or no objective)
        // in the captured 4h window as-of entry — jup-tp's zone predates the
        // window, for example. The EDR records per-fixture availability.
        expect(
          zones.filter((z) => z.kind === "demand" && z.priceHigh <= entryPrice).length === 0 ||
            objectives.length === 0,
        ).toBe(true);
        return;
      }
      // The limit rests below where price trades, stop beyond the zone's
      // wick extreme, objective above entry: strictly ordered geometry.
      expect(plan.entry).toBeLessThanOrEqual(entryPrice);
      expect(plan.stop).toBe(plan.zone.priceLow);
      expect(plan.entry).toBe(plan.zone.priceHigh);
      expect(plan.objective.price).toBeGreaterThan(plan.entry);
      expect(plan.rewardRisk).toBeGreaterThan(0);
    },
  );
});
