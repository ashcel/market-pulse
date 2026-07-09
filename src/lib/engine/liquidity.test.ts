import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { computeLiquidityPools, detectLiquiditySweeps, LIQUIDITY_WEIGHTS } from "./liquidity";
import { generateMockCandles } from "./mock-candles";
import { evaluateSignal } from "./quant";
import { computeMarketStructure } from "./structure";
import type { Candle, PivotPoint } from "./types";

// Build a pivot sequence from [kind, price] pairs with monotonic times, same
// helper as structure.test.ts — pools are tested through the real structure
// engine, never through hand-built clusters.
function pivots(...steps: [PivotPoint["kind"], number][]): PivotPoint[] {
  return steps.map(([kind, price], i) => ({ time: i + 1, price, kind }));
}

function poolsFor(...steps: [PivotPoint["kind"], number][]) {
  return computeLiquidityPools(computeMarketStructure(pivots(...steps)));
}

describe("computeLiquidityPools", () => {
  it("derives a BSL pool from an equal-high cluster at the cluster extreme", () => {
    const pools = poolsFor(["high", 100], ["low", 50], ["high", 100.05], ["low", 55]);

    expect(pools).toHaveLength(1);
    expect(pools[0].side).toBe("bsl");
    // The liquidity line is the highest of the equal highs — where buy stops rest.
    expect(pools[0].price).toBe(100.05);
    expect(pools[0].cluster.kind).toBe("eqh");
    expect(pools[0].intact).toBe(true);
  });

  it("derives an SSL pool from an equal-low cluster at the cluster extreme", () => {
    const pools = poolsFor(["low", 100], ["high", 150], ["low", 99.95], ["high", 140]);

    expect(pools).toHaveLength(1);
    expect(pools[0].side).toBe("ssl");
    expect(pools[0].price).toBe(99.95);
    expect(pools[0].cluster.kind).toBe("eql");
    expect(pools[0].intact).toBe(true);
  });

  it("returns no pools when the structure has no equal clusters", () => {
    expect(poolsFor(["low", 10], ["high", 20], ["low", 12], ["high", 24])).toEqual([]);
    expect(computeLiquidityPools(computeMarketStructure([]))).toEqual([]);
  });

  // --- Confidence components -------------------------------------------------

  it("scores more touches higher: double top 0.5, triple 0.85, quadruple 1", () => {
    const double = poolsFor(["high", 100], ["low", 50], ["high", 100], ["low", 55]);
    const triple = poolsFor(
      ["high", 100],
      ["low", 50],
      ["high", 100],
      ["low", 55],
      ["high", 100],
      ["low", 52],
    );
    const quad = poolsFor(
      ["high", 100],
      ["low", 50],
      ["high", 100],
      ["low", 55],
      ["high", 100],
      ["low", 52],
      ["high", 100],
      ["low", 53],
    );

    expect(double[0].components.touches).toBe(0.5);
    expect(triple[0].components.touches).toBeCloseTo(0.85, 10);
    expect(quad[0].components.touches).toBe(1);
  });

  it("scores tick-identical clusters as maximally tight, tolerance-edge clusters lower", () => {
    const exact = poolsFor(["high", 100], ["low", 50], ["high", 100], ["low", 55]);
    // 100 → 100.1 spans the full one-sided tolerance (0.1%), half the
    // theoretical ±tolerance span, so tightness reads 0.5.
    const spread = poolsFor(["high", 100], ["low", 50], ["high", 100.1], ["low", 55]);

    expect(exact[0].components.tightness).toBe(1);
    expect(spread[0].components.tightness).toBeCloseTo(0.5, 10);
    expect(exact[0].confidence).toBeGreaterThan(spread[0].confidence);
  });

  it("decays confidence as the pool ages behind newer swings", () => {
    const cluster: [PivotPoint["kind"], number][] = [
      ["high", 100],
      ["low", 50],
      ["high", 100],
      ["low", 55],
    ];
    // Trailing swings stay below the level so the pool remains intact — only
    // its age changes.
    const aged: [PivotPoint["kind"], number][] = [
      ...cluster,
      ["high", 90],
      ["low", 52],
      ["high", 88],
      ["low", 51],
    ];

    const fresh = poolsFor(...cluster)[0];
    const old = poolsFor(...aged)[0];
    expect(old.components.recency).toBeLessThan(fresh.components.recency);
    expect(old.confidence).toBeLessThan(fresh.confidence);
    expect(old.intact).toBe(true);
  });

  it("confidence is exactly the documented weighted blend of its components", () => {
    const pools = poolsFor(
      ["high", 100],
      ["low", 50],
      ["high", 100.05],
      ["low", 55],
      ["high", 92],
      ["low", 53],
    );

    for (const pool of pools) {
      const expected = Math.round(
        100 *
          (LIQUIDITY_WEIGHTS.touches * pool.components.touches +
            LIQUIDITY_WEIGHTS.tightness * pool.components.tightness +
            LIQUIDITY_WEIGHTS.recency * pool.components.recency),
      );
      expect(pool.confidence).toBe(expected);
      expect(pool.confidence).toBeGreaterThanOrEqual(0);
      expect(pool.confidence).toBeLessThanOrEqual(100);
    }
  });

  // --- Intact vs spent --------------------------------------------------------

  it("marks a BSL pool spent once a later swing high trades above the line", () => {
    const pools = poolsFor(
      ["high", 100],
      ["low", 50],
      ["high", 100],
      ["low", 55],
      ["high", 104], // runs the stops above 100
      ["low", 60],
    );

    const bsl = pools.find((p) => p.side === "bsl");
    expect(bsl?.intact).toBe(false);
  });

  it("marks an SSL pool spent once a later swing low trades below the line", () => {
    const pools = poolsFor(
      ["low", 100],
      ["high", 150],
      ["low", 100],
      ["high", 140],
      ["low", 96], // runs the stops below 100
      ["high", 130],
    );

    const ssl = pools.find((p) => p.side === "ssl");
    expect(ssl?.intact).toBe(false);
  });

  it("keeps a pool intact while later swings stay on the near side of the line", () => {
    const pools = poolsFor(
      ["high", 100],
      ["low", 50],
      ["high", 100],
      ["low", 55],
      ["high", 99], // rejected below the level: stops above 100 still resting
      ["low", 58],
    );

    expect(pools.find((p) => p.side === "bsl")?.intact).toBe(true);
  });

  // --- Determinism and replay safety ------------------------------------------

  it("is deterministic: identical input produces deep-equal pools", () => {
    const seq: [PivotPoint["kind"], number][] = [
      ["high", 100],
      ["low", 50],
      ["high", 100.05],
      ["low", 50.02],
      ["high", 108],
      ["low", 60],
    ];

    expect(poolsFor(...seq)).toEqual(poolsFor(...seq));
  });

  it("is replay-safe: a pool reads intact at every prefix before the run, spent after", () => {
    const seq: [PivotPoint["kind"], number][] = [
      ["high", 100],
      ["low", 50],
      ["high", 100], // cluster completes: pool exists from here
      ["low", 55],
      ["high", 104], // the swing that runs the stops
      ["low", 60],
    ];

    for (let k = 3; k <= seq.length; k++) {
      const pools = poolsFor(...seq.slice(0, k));
      const bsl = pools.find((p) => p.side === "bsl");
      expect(bsl).toBeDefined();
      // Live at bar k, the pool's intact state reflects only swings seen so
      // far — exactly what a replay from the same window reproduces.
      expect(bsl?.intact).toBe(k < 5);
      // Cluster membership never changes retroactively.
      expect(bsl?.cluster.swings.map((s) => s.price)).toEqual([100, 100]);
    }
  });

  // --- Ordering and engine exposure --------------------------------------------

  it("returns pools strongest-first", () => {
    const pools = poolsFor(
      ["high", 100],
      ["low", 50],
      ["high", 100], // double top, old
      ["low", 50.01], // double bottom forms below
      ["high", 92],
      ["low", 50.02], // triple bottom — more touches, fresher
      ["high", 90],
    );

    expect(pools.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < pools.length; i++) {
      expect(pools[i].confidence).toBeLessThanOrEqual(pools[i - 1].confidence);
    }
  });

  it("is exposed on SignalEvaluation.liquidity for every evaluation", () => {
    const candles = generateMockCandles("BTC", "1H", 500);
    const evaluation = evaluateSignal("BTC", candles, computePivots(candles));

    expect(Array.isArray(evaluation.liquidity)).toBe(true);
    for (const pool of evaluation.liquidity) {
      expect(["bsl", "ssl"]).toContain(pool.side);
      expect(Number.isFinite(pool.price)).toBe(true);
    }
  });
});

describe("detectLiquiditySweeps", () => {
  function candle(time: number, high: number, low: number, close: number): Candle {
    return { time, open: close, high, low, close, volume: 1000 };
  }

  // A BSL pool at 100: equal highs at pivot times 1 and 3 (the completing
  // touch is t=3), lows between. Candles carry later times.
  function bslPools() {
    return computeLiquidityPools(
      computeMarketStructure(pivots(["high", 100], ["low", 50], ["high", 100], ["low", 55])),
    );
  }

  function sslPools() {
    return computeLiquidityPools(
      computeMarketStructure(pivots(["low", 100], ["high", 150], ["low", 100], ["high", 140])),
    );
  }

  it("detects a buy-side sweep: wick above the pool, close back below", () => {
    const sweeps = detectLiquiditySweeps(bslPools(), [
      candle(10, 99, 95, 98),
      candle(11, 100.5, 97, 99.2), // raids the stops above 100, closes back under
      candle(12, 99, 96, 97),
    ]);

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].side).toBe("bsl");
    expect(sweeps[0].time).toBe(11);
    expect(sweeps[0].extreme).toBe(100.5);
    expect(sweeps[0].close).toBe(99.2);
    expect(sweeps[0].penetration).toBeCloseTo(0.005, 10);
    expect(sweeps[0].pool.price).toBe(100);
  });

  it("detects a sell-side sweep: wick below the pool, close back above", () => {
    const sweeps = detectLiquiditySweeps(sslPools(), [
      candle(10, 105, 101, 102),
      candle(11, 103, 99.4, 100.8), // raids the stops below 100, closes back over
    ]);

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].side).toBe("ssl");
    expect(sweeps[0].extreme).toBe(99.4);
    expect(sweeps[0].close).toBe(100.8);
  });

  it("classifies a close beyond the level as a breakout, not a sweep — and the pool stays spent", () => {
    const sweeps = detectLiquiditySweeps(bslPools(), [
      candle(10, 100.5, 98, 100.4), // closes above: acceptance, not a raid
      candle(11, 101, 97, 98), // a later wick-and-reject cannot sweep spent stops
    ]);

    expect(sweeps).toHaveLength(0);
  });

  it("emits at most one sweep per pool: the first penetration decides", () => {
    const sweeps = detectLiquiditySweeps(bslPools(), [
      candle(10, 100.3, 97, 99), // sweep
      candle(11, 100.8, 96, 98), // stops already gone — not a second sweep
    ]);

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].time).toBe(10);
  });

  it("does not read an exact touch of the level as penetration", () => {
    const sweeps = detectLiquiditySweeps(bslPools(), [candle(10, 100, 97, 99)]);

    expect(sweeps).toHaveLength(0);
  });

  it("ignores candles at or before the pool's completing touch", () => {
    // t=3 is the completing touch's own bar; a wick there cannot sweep the
    // pool it is completing.
    const sweeps = detectLiquiditySweeps(bslPools(), [
      candle(2, 100.6, 95, 96),
      candle(3, 100.4, 95, 97),
    ]);

    expect(sweeps).toHaveLength(0);
  });

  it("reports a sweep even while swing bookkeeping still calls the pool intact", () => {
    // The raid wick never confirms as a pivot (no swing beyond the level), so
    // the pool reads intact structurally — the candle-level detector is the
    // component that closes exactly this gap.
    const pools = bslPools();
    const sweeps = detectLiquiditySweeps(pools, [candle(10, 100.5, 97, 99)]);

    expect(pools[0].intact).toBe(true);
    expect(sweeps).toHaveLength(1);
  });

  it("returns no sweeps while price never reaches the pool", () => {
    expect(detectLiquiditySweeps(bslPools(), [candle(10, 99, 95, 98)])).toEqual([]);
    expect(detectLiquiditySweeps([], [candle(10, 200, 1, 100)])).toEqual([]);
  });

  it("detects sweeps on both sides and orders events by time", () => {
    // One structure with a double top at 100 and a double bottom at 90.
    const pools = computeLiquidityPools(
      computeMarketStructure(
        pivots(["high", 100], ["low", 90], ["high", 100], ["low", 90], ["high", 96]),
      ),
    );
    const sweeps = detectLiquiditySweeps(pools, [
      candle(10, 97, 89.5, 91), // SSL sweep below 90
      candle(11, 100.4, 95, 98), // BSL sweep above 100
    ]);

    expect(sweeps.map((s) => [s.side, s.time])).toEqual([
      ["ssl", 10],
      ["bsl", 11],
    ]);
  });

  it("is deterministic: identical input produces deep-equal sweeps", () => {
    const candles = [candle(10, 100.5, 97, 99), candle(11, 98, 94, 95)];

    expect(detectLiquiditySweeps(bslPools(), candles)).toEqual(
      detectLiquiditySweeps(bslPools(), candles),
    );
  });

  it("is replay-safe: sweeps are append-only as candles arrive", () => {
    const candles = [
      candle(10, 99, 95, 98),
      candle(11, 100.5, 97, 99.2), // the sweep candle
      candle(12, 99, 96, 97),
      candle(13, 100.8, 95, 96), // later penetration of already-spent stops
    ];

    let previous = 0;
    for (let k = 1; k <= candles.length; k++) {
      const sweeps = detectLiquiditySweeps(bslPools(), candles.slice(0, k));
      // Once emitted, the same single event persists with identical fields.
      expect(sweeps.length).toBeGreaterThanOrEqual(previous);
      expect(sweeps.length).toBe(k >= 2 ? 1 : 0);
      if (sweeps.length > 0) expect(sweeps[0].time).toBe(11);
      previous = sweeps.length;
    }
  });

  it("is exposed on SignalEvaluation.liquiditySweeps for every evaluation", () => {
    const candles = generateMockCandles("BTC", "1H", 500);
    const evaluation = evaluateSignal("BTC", candles, computePivots(candles));

    expect(Array.isArray(evaluation.liquiditySweeps)).toBe(true);
    for (const sweep of evaluation.liquiditySweeps) {
      expect(["bsl", "ssl"]).toContain(sweep.side);
      expect(evaluation.liquidity).toContain(sweep.pool);
    }
  });
});
