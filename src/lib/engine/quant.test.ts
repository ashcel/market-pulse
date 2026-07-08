import { afterEach, describe, expect, it, vi } from "vitest";

import { computePivots, pivotWindow } from "./analysis";
import { generateMockCandles } from "./mock-candles";
import type { Candle } from "./types";

describe("runBacktest replay pivot safety", () => {
  afterEach(() => {
    vi.doUnmock("./analysis");
    vi.resetModules();
  });

  it("uses computePivots(candles.slice(0, i + 1)) as the replay oracle", async () => {
    const pivotInputs: Candle[][] = [];

    vi.doMock("./analysis", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./analysis")>();
      return {
        ...actual,
        computePivots: (candles: Candle[]) => {
          pivotInputs.push(candles);
          return actual.computePivots(candles);
        },
      };
    });

    const { runBacktest } = await import("./quant");
    const candles = generateMockCandles("BTC", "1H", 70);

    runBacktest(candles, undefined, "breakout");

    expect(pivotInputs).toHaveLength(10);
    for (const [offset, pivotInput] of pivotInputs.entries()) {
      const replayBar = 55 + offset;
      expect(pivotInput).toEqual(candles.slice(0, replayBar + 1));
      expect(pivotInput).not.toBe(candles);
      expect(pivotInput.length).toBeLessThan(candles.length);
    }
  });

  it("does not expose pivots before their confirmation window has closed", () => {
    const candles = generateMockCandles("DOGE", "1H", 160);
    let inspectedPivots = 0;

    for (let i = 55; i < candles.length - 5; i++) {
      const window = candles.slice(0, i + 1);
      const k = pivotWindow(window.length);
      const indexByTime = new Map(window.map((candle, index) => [candle.time, index]));

      for (const pivot of computePivots(window)) {
        const pivotIndex = indexByTime.get(pivot.time);
        expect(pivotIndex).toBeDefined();
        expect((pivotIndex as number) + k).toBeLessThanOrEqual(i);
        inspectedPivots++;
      }
    }

    expect(inspectedPivots).toBeGreaterThan(0);
  });

  it("produces deterministic replay summaries for identical input", async () => {
    const { runBacktest } = await import("./quant");
    const candles = generateMockCandles("SOL", "1H", 1000);

    const first = runBacktest(candles, undefined, "lower-high-rejection");
    const second = runBacktest(candles, undefined, "lower-high-rejection");

    expect(second).toEqual(first);
  });
});
