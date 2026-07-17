import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { computeLiquidityPools, type LiquidityPool } from "./liquidity";
import { generateMockCandles } from "./mock-candles";
import { resolveObjectives } from "./objectives";
import { computeMarketStructure, type EqualLevel } from "./structure";
import type { PivotPoint } from "./types";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

function pivot(kind: "high" | "low", price: number, time: number): PivotPoint {
  return { kind, price, time };
}

/**
 * Minimal hand-built pool for affinity unit tests — the resolver reads only
 * `side`, `price`, and `intact`; cluster/confidence are irrelevant to it.
 */
function fakePool(side: "bsl" | "ssl", price: number, intact = true): LiquidityPool {
  const cluster: EqualLevel = { kind: side === "bsl" ? "eqh" : "eql", price, swings: [] };
  return {
    side,
    price,
    cluster,
    intact,
    confidence: 50,
    tier: "Moderate",
    components: { touches: 0.5, tightness: 1, recency: 1 },
  };
}

describe("resolveObjectives", () => {
  // Uptrend with a completed pullback at the end: 130 settles weak (its
  // counter-leg to 122 never broke the 112 low), 128 is unresolved; both are
  // untaken. The earlier highs 110/120 were taken by later higher highs.
  const uptrend = computeMarketStructure([
    pivot("low", 100, 1),
    pivot("high", 110, 2),
    pivot("low", 105, 3),
    pivot("high", 120, 4),
    pivot("low", 112, 5),
    pivot("high", 130, 6),
    pivot("low", 122, 7),
    pivot("high", 128, 8),
  ]);

  it("ranks untaken weak/unresolved highs above fromPrice by proximity, preferred first", () => {
    const candidates = resolveObjectives(uptrend, [], "long", 124);
    expect(candidates.map((c) => c.price)).toEqual([128, 130]);
    expect(candidates.map((c) => c.strength)).toEqual(["unresolved", "weak"]);
    expect(candidates[0].swing.time).toBe(8);
    for (const c of candidates) expect(c.direction).toBe("long");
    // Strictly ordered by proximity, no duplicate levels.
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].price).toBeGreaterThan(candidates[i - 1].price);
    }
  });

  it("skips taken candidates — a level a later swing traded beyond is spent", () => {
    // From 106, the weak high 110 sits above but 120 later traded through it.
    const candidates = resolveObjectives(uptrend, [], "long", 106);
    expect(candidates.some((c) => c.swing.price === 110)).toBe(false);
    expect(candidates.some((c) => c.swing.price === 120)).toBe(false);
  });

  it("mirrors for shorts: untaken weak/unresolved lows below fromPrice, nearest first", () => {
    const downtrend = computeMarketStructure([
      pivot("high", 130, 1),
      pivot("low", 120, 2),
      pivot("high", 125, 3),
      pivot("low", 110, 4),
      pivot("high", 118, 5),
      pivot("low", 102, 6),
      pivot("high", 108, 7),
      pivot("low", 104, 8),
    ]);
    const candidates = resolveObjectives(downtrend, [], "short", 107);
    expect(candidates.map((c) => c.price)).toEqual([104, 102]);
    expect(candidates.map((c) => c.strength)).toEqual(["unresolved", "weak"]);
    for (const c of candidates) expect(c.direction).toBe("short");
  });

  it("excludes strong swings — a defended level is protection, not a draw", () => {
    // A downtrend read from the long side: every high's pullback broke the
    // prior low, so every completed high is strong. Only the still-unresolved
    // final low's counterpart remains — from below the last high, nothing
    // weak sits above.
    const downtrend = computeMarketStructure([
      pivot("high", 130, 1),
      pivot("low", 120, 2),
      pivot("high", 125, 3),
      pivot("low", 110, 4),
      pivot("high", 115, 5),
      pivot("low", 100, 6),
    ]);
    const candidates = resolveObjectives(downtrend, [], "long", 101);
    // 130 was never taken but is unresolved (first swing); 125/115 are strong.
    expect(candidates.every((c) => c.strength !== "strong")).toBe(true);
    expect(candidates.some((c) => c.swing.price === 125)).toBe(false);
    expect(candidates.some((c) => c.swing.price === 115)).toBe(false);
  });

  it("requires the candidate strictly beyond fromPrice", () => {
    expect(resolveObjectives(uptrend, [], "long", 130).length).toBe(0);
    expect(resolveObjectives(uptrend, [], "long", 129.999).map((c) => c.price)).toEqual([130]);
  });

  it("returns empty when everything above is strong or taken — never fabricates", () => {
    const grind = computeMarketStructure([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 95, 3), // breaks 100: 110 is strong
      pivot("high", 112, 4),
    ]);
    // 110 is strong and taken; 112 is the last swing (unresolved) — from
    // above it, nothing qualifies.
    expect(resolveObjectives(grind, [], "long", 112)).toEqual([]);
  });

  describe("pool affinity", () => {
    // EQH cluster 110 / 109.95 (within tolerance): pool line = 110. Both
    // members settle weak and stay untaken.
    const cluster = computeMarketStructure([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 105, 3),
      pivot("high", 109.95, 4),
      pivot("low", 106, 5),
      pivot("high", 108, 6),
    ]);
    const pools = computeLiquidityPools(cluster);

    it("promotes a coinciding candidate's price to the intact pool line, once", () => {
      const candidates = resolveObjectives(cluster, pools, "long", 106.5);
      // 108 first (no pool nearby), then one candidate at the cluster line —
      // the 109.95 member promoted to 110 and the 110 member collapsed into
      // it, never two candidates for one liquidity level.
      expect(candidates.map((c) => c.price)).toEqual([108, 110]);
      expect(candidates[0].pool).toBeNull();
      expect(candidates[1].pool?.price).toBe(110);
      expect(candidates.filter((c) => c.pool !== null).length).toBe(1);
    });

    it("uses a pool line sitting between the candidate and fromPrice", () => {
      const between = fakePool("bsl", 127);
      const candidates = resolveObjectives(uptrend, [between], "long", 124);
      // 128's stops rest at the intact cluster extreme on the path (127).
      expect(candidates[0].price).toBe(127);
      expect(candidates[0].pool).toBe(between);
      expect(candidates[0].swing.price).toBe(128);
    });

    it("ignores spent pools and pools on the wrong side", () => {
      const spent = fakePool("bsl", 127, false);
      const ssl = fakePool("ssl", 127);
      const candidates = resolveObjectives(uptrend, [spent, ssl], "long", 124);
      expect(candidates.map((c) => c.price)).toEqual([128, 130]);
      expect(candidates.every((c) => c.pool === null)).toBe(true);
    });
  });

  describe("replay safety", () => {
    it("is deterministic over identical input", () => {
      for (const symbol of ["BTC", "ETH", "SOL"]) {
        const candles = generateMockCandles(symbol, "1H", 300);
        const structure = computeMarketStructure(computePivots(candles));
        const pools = computeLiquidityPools(structure);
        const from = candles[candles.length - 1].close;
        expect(resolveObjectives(structure, pools, "long", from)).toEqual(
          resolveObjectives(structure, pools, "long", from),
        );
      }
    });

    it("resolves at bar k from bars ≤ k only (prefix-window sweep)", () => {
      for (const symbol of ["BTC", "ETH"]) {
        const candles = generateMockCandles(symbol, "1H", 360);
        for (let n = 60; n <= candles.length; n += 20) {
          const window = candles.slice(0, n);
          const structure = computeMarketStructure(computePivots(window));
          const pools = computeLiquidityPools(structure);
          const from = window[window.length - 1].close;
          for (const direction of ["long", "short"] as const) {
            const candidates = resolveObjectives(structure, pools, direction, from);
            for (const c of candidates) {
              // Nothing in the result can postdate the window.
              expect(c.swing.time).toBeLessThanOrEqual(window[window.length - 1].time);
              expect(direction === "long" ? c.price > from : c.price < from).toBe(true);
            }
            for (let i = 1; i < candidates.length; i++) {
              const closer =
                direction === "long"
                  ? candidates[i].price > candidates[i - 1].price
                  : candidates[i].price < candidates[i - 1].price;
              expect(closer).toBe(true);
            }
          }
        }
      }
    });
  });
});

describe("dreimann annotation fidelity — objectives", () => {
  // Logic correctness only: does the resolver pick the level the trader
  // called the objective? Never tune a threshold against these (R5).

  const weakStructureTrades = DREIMANN_TRADES.filter((name) => {
    const { labels } = loadDreimannFixture(name);
    return labels.objective.claimsWeakStructure && labels.objective.withinWindow;
  });

  it.each(weakStructureTrades)(
    "%s: the preferred objective at entry is the trader's weak-structure TP level",
    (name) => {
      const fixture = loadDreimannFixture(name);
      const { labels } = fixture;
      const candles = fixture.series[labels.executionTimeframe]!;
      const entryTime = labelTime(labels.entry.approxTimeUtc);
      const structure = computeMarketStructure(
        computePivots(candles.filter((c) => c.time <= entryTime)),
      );
      const pools = computeLiquidityPools(structure);
      const candidates = resolveObjectives(structure, pools, "long", labels.entry.price);

      const preferred = candidates[0];
      expect(preferred).toBeDefined();
      const tolerance = labels.objective.tolerancePct / 100;
      expect(
        Math.abs(preferred.price - labels.objective.price) / labels.objective.price,
      ).toBeLessThanOrEqual(tolerance);
      expect(preferred.strength).not.toBe("strong");
    },
  );

  it("zec-tp: the recorded divergence — the engine offers no candidate at the 487 TP", () => {
    // trades.txt makes no weak-structure claim for this trade and the engine
    // reads the 487-area high strong as-of entry (its pullback broke the
    // prior low), so the resolver must not present it as a draw. Documented
    // in EDR 0008 as an observed divergence, not asserted away.
    const fixture = loadDreimannFixture("zec-tp");
    const { labels } = fixture;
    const candles = fixture.series[labels.executionTimeframe]!;
    const entryTime = labelTime(labels.entry.approxTimeUtc);
    const structure = computeMarketStructure(
      computePivots(candles.filter((c) => c.time <= entryTime)),
    );
    const pools = computeLiquidityPools(structure);
    const candidates = resolveObjectives(structure, pools, "long", labels.entry.price);
    const tolerance = labels.objective.tolerancePct / 100;
    const atLabel = candidates.filter(
      (c) => Math.abs(c.price - labels.objective.price) / labels.objective.price <= tolerance,
    );
    expect(atLabel).toEqual([]);
  });
});
