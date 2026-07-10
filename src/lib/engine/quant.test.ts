import { afterEach, describe, expect, it, vi } from "vitest";

import * as analysis from "./analysis";
import { computePivots, pivotWindow } from "./analysis";
import { generateMockCandles } from "./mock-candles";
import type { Candle, PivotPoint } from "./types";

// Captured before any module mock is installed, so the wrapper below always
// calls the genuine implementation (never itself via a rewritten binding).
const actualComputePivots = analysis.computePivots;

// The replay-oracle test needs to observe what runBacktest passes to
// computePivots. Vitest gives us doMock/doUnmock; bun's vitest-compat `vi`
// has neither, but bun:test's mock.module can install the same wrapper. Bun
// cannot uninstall a module mock, so the wrapper routes through a recorder
// toggle: with the recorder unset it is a pure passthrough, keeping every
// other test's behavior identical even while the wrapper stays installed.
let recordPivotInput: ((candles: Candle[]) => void) | null = null;

async function installComputePivotsRecorder(): Promise<void> {
  const wrapped = {
    ...analysis,
    computePivots: (candles: Candle[]): PivotPoint[] => {
      recordPivotInput?.(candles);
      return actualComputePivots(candles);
    },
  };
  if (typeof vi.doMock === "function") {
    vi.doMock("./analysis", () => wrapped);
  } else {
    const { mock } = await import("bun:test");
    mock.module("./analysis", () => wrapped);
  }
}

describe("runBacktest replay pivot safety", () => {
  afterEach(() => {
    recordPivotInput = null;
    // Full uninstall where the runner supports it (vitest); under bun the
    // wrapper stays but is a passthrough once the recorder is cleared.
    vi.doUnmock?.("./analysis");
    vi.resetModules?.();
  });

  it("uses computePivots(candles.slice(0, i + 1)) as the replay oracle", async () => {
    const pivotInputs: Candle[][] = [];
    recordPivotInput = (candles) => pivotInputs.push(candles);
    await installComputePivotsRecorder();

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

describe("gradeRisk", () => {
  // Dynamic import for consistency with the mocked-module hygiene above:
  // a static top-level import would cache quant before the replay tests mock
  // "./analysis".
  const load = () => import("./quant");

  it("grades by the ATR% bands", async () => {
    const { gradeRisk } = await load();

    expect(gradeRisk(1.0)).toBe("low");
    expect(gradeRisk(2.2)).toBe("medium");
    expect(gradeRisk(3.0)).toBe("medium");
    expect(gradeRisk(4.5)).toBe("high");
    expect(gradeRisk(7.0)).toBe("high");
  });

  it("bumps a counter-trend trade one grade, capped at high", async () => {
    const { gradeRisk } = await load();

    expect(gradeRisk(1.0, true)).toBe("medium");
    expect(gradeRisk(3.0, true)).toBe("high");
    expect(gradeRisk(7.0, true)).toBe("high");
  });

  it("returns null without an ATR read", async () => {
    const { gradeRisk } = await load();

    expect(gradeRisk(null)).toBeNull();
    expect(gradeRisk(Number.NaN)).toBeNull();
  });
});
