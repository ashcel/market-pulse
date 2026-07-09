import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { generateMockCandles } from "./mock-candles";
import { analyticsFor } from "./quant";
import { toAlternatingSwings } from "./structure";
import type { Candle, PivotPoint } from "./types";

// ---------------------------------------------------------------------------
// Decision-evidence fixtures for the proposed nearestSupport/nearestResistance
// migration (raw pivots → alternating swing legs), per the design review's
// "right-edge fixtures" requirement.
//
// Each scenario pins BOTH behaviors: the raw-pivot candidate set the engine
// ships today (via analyticsFor with computePivots output), and the collapsed
// set the migration proposes (via analyticsFor with toAlternatingSwings
// output). Feeding the collapsed set through analyticsFor simulates the
// proposed algorithm *exactly*: toAlternatingSwings returns a subset of its
// input that preserves each run's extreme, so a qualifying candidate exists in
// the collapsed set iff one exists in the raw set — the candle fallback
// activates in identical cases (asserted below as "fallback equivalence").
//
// The assertions only pin what each algorithm does. The judgment about which
// answer better represents tradeable support/resistance lives in the comments
// on each scenario and in the migration decision record.
// ---------------------------------------------------------------------------

const STEP = 3600;
const T0 = 1_700_000_000;

function bar(i: number, high: number, low: number, close = (high + low) / 2): Candle {
  return { time: T0 + i * STEP, open: close, high, low, close, volume: 1000 };
}

/** Flat series providing a controlled last close for hand-built pivot scenarios. */
function flatSeries(bars: number, close: number): Candle[] {
  return Array.from({ length: bars }, (_, i) => bar(i, close + 0.1, close - 0.1, close));
}

function handPivots(...steps: [PivotPoint["kind"], number][]): PivotPoint[] {
  return steps.map(([kind, price], i) => ({ time: T0 + (i + 1) * STEP, price, kind }));
}

function key(p: PivotPoint): string {
  return `${p.time}:${p.kind}:${p.price}`;
}

/**
 * Scenario A — right-edge resistance run from an unconfirmed pullback.
 *
 * 60 bars (pivot window k = 3): a steep rise thrusts to a confirmed high at
 * 100 (bar 10), pulls back shallowly — the pullback low can never confirm as
 * a pivot because the pre-thrust bars inside its ±k window have lower lows —
 * then extends to a confirmed high at 102 (bar 16) and fades below both.
 * computePivots therefore emits two consecutive HIGH pivots with no low
 * between them: exactly the same-kind run toAlternatingSwings collapses.
 */
function rightEdgeResistanceRun(): Candle[] {
  const head: Array<[number, number]> = [
    [81, 79],
    [82, 80],
    [83, 81],
    [84, 82],
    [85, 83],
    [86, 84],
    [88, 86],
    [90, 88],
    [92, 90],
    [94, 91],
    [100, 95], // bar 10 — thrust high, confirmed pivot
    [98, 97],
    [97, 96], // bar 12 — shallow pullback low; bar 9's low (91) sits in its window → unconfirmed
    [98, 96.5],
    [99, 97],
    [101, 98],
    [102, 99], // bar 16 — leg extreme, confirmed pivot
  ];
  const candles = head.map(([high, low], i) => bar(i, high, low));
  for (let i = 17; i < 60; i++) {
    const high = 101 - 0.04 * (i - 17); // monotonic fade: no further pivots form
    candles.push(bar(i, high, high - 2, high - 1));
  }
  return candles;
}

/** Scenario B — the exact mirror: a support run from an unconfirmed bounce. */
function rightEdgeSupportRun(): Candle[] {
  const head: Array<[number, number]> = [
    [121, 119],
    [120, 118],
    [119, 117],
    [118, 116],
    [117, 115],
    [116, 114],
    [114, 112],
    [112, 110],
    [110, 108],
    [109, 106],
    [105, 90], // bar 10 — thrust low, confirmed pivot
    [92, 91],
    [93, 91.5], // bar 12 — shallow bounce high; bar 9's high (109) sits in its window → unconfirmed
    [92.5, 91],
    [92, 90.5],
    [91, 89.5],
    [90, 88], // bar 16 — leg extreme, confirmed pivot
  ];
  const candles = head.map(([high, low], i) => bar(i, high, low));
  for (let i = 17; i < 60; i++) {
    const low = 89 + 0.04 * (i - 17); // monotonic recovery: no further pivots form
    candles.push(bar(i, low + 2, low, low + 1));
  }
  return candles;
}

describe("nearest S/R candidates: raw pivots vs alternating swings", () => {
  it("A: right-edge resistance run — raw keeps the first overhead level (100), collapsed jumps to the leg extreme (102)", () => {
    const candles = rightEdgeResistanceRun();
    const pivots = computePivots(candles);

    // Precondition: the fixture must actually produce a pure same-kind run.
    // If pivot detection changes and this drifts, fail loudly here rather
    // than silently testing a different scenario.
    expect(pivots.map((p) => `${p.kind}:${p.price}`)).toEqual(["high:100", "high:102"]);
    expect(toAlternatingSwings(pivots).map((p) => p.price)).toEqual([102]);

    const raw = analyticsFor(candles, pivots);
    const proposed = analyticsFor(candles, toAlternatingSwings(pivots));

    // Close faded to ~98.3, below both highs. Raw answers 100: the first
    // level where sellers appeared, and — since price broke above it and fell
    // back — the polarity level trapped breakout buyers defend. A retest
    // rally meets 100 before 102 ever matters. Collapsed discards it.
    expect(raw.resistance).toBe(100);
    expect(proposed.resistance).toBe(102);

    // The proposed level reads as farther away, muting proximity warnings.
    expect(raw.distanceToResistancePercent).not.toBeNull();
    expect(proposed.distanceToResistancePercent).not.toBeNull();
    expect(raw.distanceToResistancePercent!).toBeLessThan(proposed.distanceToResistancePercent!);

    // Fallback equivalence: no low pivots exist on either side, so support
    // resolves through the same candle fallback for both algorithms.
    expect(proposed.support).toBe(raw.support);
  });

  it("B: right-edge support run — raw keeps the first demand shelf (90), collapsed jumps to the leg extreme (88)", () => {
    const candles = rightEdgeSupportRun();
    const pivots = computePivots(candles);

    expect(pivots.map((p) => `${p.kind}:${p.price}`)).toEqual(["low:90", "low:88"]);
    expect(toAlternatingSwings(pivots).map((p) => p.price)).toEqual([88]);

    const raw = analyticsFor(candles, pivots);
    const proposed = analyticsFor(candles, toAlternatingSwings(pivots));

    // Close recovered to ~91.7, above both lows. Raw answers 90 — the
    // nearest level where buyers actually stepped in. Collapsed answers 88,
    // widening every support-anchored distance (and a swing-method stop).
    expect(raw.support).toBe(90);
    expect(proposed.support).toBe(88);
    expect(raw.distanceToSupportPercent!).toBeLessThan(proposed.distanceToSupportPercent!);

    // Fallback equivalence on the resistance side (no high pivots at all).
    expect(proposed.resistance).toBe(raw.resistance);
  });

  it("C: tight cluster of run highs — raw reports the supply band's proximal edge, collapsed its distal edge", () => {
    // Three run highs inside a 1% band, price just under the band. This is
    // the shape the migration's "noise inside one leg" rationale targets —
    // yet for proximity purposes the proximal edge (100) is the honest read:
    // a long entered at 99.8 is AT the supply band, which raw reports
    // (0.2% away) and collapsed hides (1.2% away). Note the theoretical
    // counter-benefit — avoiding a premature breakout call inside the band —
    // cannot materialize in classifySetup: pivot-derived resistance is above
    // close by construction, so the breakout branch is only reachable via
    // the candle fallback, which this migration does not change.
    const candles = flatSeries(30, 99.8);
    const cluster = handPivots(["high", 100], ["high", 100.4], ["high", 101]);

    const raw = analyticsFor(candles, cluster);
    const proposed = analyticsFor(candles, toAlternatingSwings(cluster));

    expect(raw.resistance).toBe(100);
    expect(proposed.resistance).toBe(101);
    expect(raw.distanceToResistancePercent).toBe(0.2);
    expect(proposed.distanceToResistancePercent).toBe(1.2);
  });

  it("D: run of lows where the newest touch is interior — collapsed discards the freshest level for the defended extreme", () => {
    // Lows print 50, then 48, then 52 with no confirmed high between: one
    // down-leg whose most recent (nearest, freshest) touch is 52. Raw
    // answers 52 — the honest nearest demand, and the first level a
    // retracement from 53 meets. Collapsed answers 48 — the leg extreme, the
    // *defended* level a swing-method stop should sit below (a stop under 52
    // is a wick-out magnet). This is the one scenario where each algorithm
    // wins for a different consumer: proximity/distance wants 52, stop
    // anchoring wants 48.
    const candles = flatSeries(30, 53);
    const run = handPivots(["low", 50], ["low", 48], ["low", 52]);

    expect(toAlternatingSwings(run).map((p) => p.price)).toEqual([48]);

    const raw = analyticsFor(candles, run);
    const proposed = analyticsFor(candles, toAlternatingSwings(run));

    expect(raw.support).toBe(52);
    expect(proposed.support).toBe(48);
  });

  it("E: cleanly alternating structure — the migration is a no-op", () => {
    const candles = flatSeries(30, 100);
    const alternating = handPivots(["low", 90], ["high", 110], ["low", 95], ["high", 108]);

    // Alternation-validated input passes through toAlternatingSwings intact.
    expect(toAlternatingSwings(alternating)).toEqual(alternating);

    const raw = analyticsFor(candles, alternating);
    const proposed = analyticsFor(candles, toAlternatingSwings(alternating));

    expect(raw.support).toBe(95);
    expect(raw.resistance).toBe(108);
    expect(proposed.support).toBe(raw.support);
    expect(proposed.resistance).toBe(raw.resistance);
  });

  it("property: on realistic series, collapsed levels are never closer than raw levels (subset invariant)", () => {
    // toAlternatingSwings output ⊆ its input, and a run's extreme qualifies
    // as a candidate whenever any run member does. Two consequences, asserted
    // across deterministic mock series: (1) proposed support ≤ raw support ≤
    // close side, mirrored for resistance — levels only move away from
    // price, never toward it; (2) every collapsed swing is literally one of
    // the raw pivots.
    for (const symbol of ["BTC", "ETH", "SOL", "DOGE", "PEPE"]) {
      const candles = generateMockCandles(symbol, "1H", 500);
      const pivots = computePivots(candles);
      const swings = toAlternatingSwings(pivots);

      const rawSet = new Set(pivots.map(key));
      for (const swing of swings) {
        expect(rawSet.has(key(swing))).toBe(true);
      }

      const raw = analyticsFor(candles, pivots);
      const proposed = analyticsFor(candles, swings);

      if (raw.support !== null && proposed.support !== null) {
        expect(proposed.support).toBeLessThanOrEqual(raw.support);
      }
      if (raw.resistance !== null && proposed.resistance !== null) {
        expect(proposed.resistance).toBeGreaterThanOrEqual(raw.resistance);
      }
    }
  });
});
