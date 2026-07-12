import { describe, expect, it } from "vitest";

import { meanWithSe, shrunkRate, wilson95 } from "./report-stats";

describe("wilson95", () => {
  it("matches the known interval for 5/44 (the early 1.0.0 record)", () => {
    const iv = wilson95(5, 44)!;
    expect(iv.p).toBeCloseTo(0.1136, 3);
    // Reference values computed independently (R binom.confint, wilson).
    expect(iv.low).toBeCloseTo(0.0495, 3);
    expect(iv.high).toBeCloseTo(0.2394, 3);
  });

  it("stays inside [0,1] at the extremes and handles n=0", () => {
    const zero = wilson95(0, 10)!;
    expect(zero.low).toBe(0);
    expect(zero.high).toBeGreaterThan(0);
    const all = wilson95(10, 10)!;
    expect(all.high).toBeCloseTo(1, 12);
    expect(all.low).toBeLessThan(1);
    expect(wilson95(0, 0)).toBeNull();
  });
});

describe("meanWithSe", () => {
  it("computes mean and SE", () => {
    const m = meanWithSe([1, -1, 1, -1])!;
    expect(m.mean).toBe(0);
    expect(m.se).toBeCloseTo(Math.sqrt((4 / 3) * 0.25), 6);
  });

  it("returns null SE for a single value and null for empty", () => {
    expect(meanWithSe([2])!.se).toBeNull();
    expect(meanWithSe([])).toBeNull();
  });
});

describe("shrunkRate", () => {
  it("pulls a tiny cell most of the way to the pool", () => {
    // 0 wins in 2 trades, pool at 40%: shrinks to near the pool, not to 0.
    const s = shrunkRate(0, 2, 0.4);
    expect(s).toBeCloseTo((0 + 15 * 0.4) / 17, 6);
    expect(s).toBeGreaterThan(0.3);
  });

  it("lets a large cell dominate its own evidence", () => {
    const s = shrunkRate(60, 100, 0.4);
    expect(s).toBeGreaterThan(0.55); // 60% barely moved
  });

  it("returns the pool when there is no evidence at all", () => {
    expect(shrunkRate(0, 0, 0.4, 0)).toBe(0.4);
  });
});
