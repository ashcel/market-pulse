import { describe, expect, it } from "vitest";

import { computeRelativeRead, pearson } from "./relative";
import type { Candle } from "./types";

function series(closes: number[], startTime = 0, step = 3600): Candle[] {
  return closes.map((close, i) => ({
    time: startTime + i * step,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

describe("pearson", () => {
  it("is 1 for a perfectly linear relation and -1 for its inverse", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
  });

  it("matches a hand-computed value", () => {
    // r for x=[1,2,3], y=[1,3,2] is 0.5
    expect(pearson([1, 2, 3], [1, 3, 2])).toBeCloseTo(0.5, 10);
  });

  it("is null on zero variance or too-short input", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1], [2])).toBeNull();
  });
});

describe("computeRelativeRead", () => {
  it("computes RS as the difference of the two series' own % changes", () => {
    const n = 200;
    // Asset +50% over the window vs BTC flat: both linear ramps.
    const asset = series(Array.from({ length: n }, (_, i) => 100 + i * 0.5));
    const btc = series(Array.from({ length: n }, () => 100));
    const read = computeRelativeRead(asset, btc);
    expect(read.rsBtc24h).toBeGreaterThan(0);
    expect(read.rsBtc7d).toBeGreaterThan(read.rsBtc24h); // longer ramp, bigger gap
  });

  it("reads corr ≈ 1 for identical return streams and pairs strictly by bar time", () => {
    const n = 200;
    const closes = Array.from({ length: n }, (_, i) => 100 * (1 + 0.001 * Math.sin(i)));
    const asset = series(closes);
    const btc = series(closes);
    expect(computeRelativeRead(asset, btc).corrBtc7d).toBeCloseTo(1, 6);

    // Time-shift BTC by one bar: naive index pairing would still see identical
    // arrays; time-aligned pairing must compare shifted returns instead.
    const shifted = series(closes, 3600);
    const corrShifted = computeRelativeRead(asset, shifted).corrBtc7d;
    expect(corrShifted).not.toBeNull();
    expect(corrShifted!).toBeLessThan(0.99);
  });

  it("returns null corr below the 48-overlapping-returns floor, but still reads RS", () => {
    const asset = series(Array.from({ length: 30 }, (_, i) => 100 + i));
    const btc = series(Array.from({ length: 30 }, () => 100));
    const read = computeRelativeRead(asset, btc);
    expect(read.corrBtc7d).toBeNull();
    expect(read.rsBtc24h).toBeGreaterThan(0);
  });
});
