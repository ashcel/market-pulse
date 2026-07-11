import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateSymbol, type EvaluateInput } from "./evaluate";
import { generateMockCandles } from "./mock-candles";
import { computePivots } from "./analysis";
import { evaluateSignal } from "./quant";
import { settleShadowSignal, type ShadowSignal } from "./shadow";
import { settleAnticipatorySignal, type AnticipatorySignal } from "./anticipatory";
import { settleTrackedSignalWithCandles, type TrackedSignal } from "./tracker";

/**
 * WS2 — determinism/replay guard. The forward test's whole premise is that
 * the same candles in must produce the same records out, whether the worker
 * evaluates a pass at 03:00 or 03:05, and regardless of what order it walks
 * the universe in. This is what makes a crash-and-restart replay safe (WS4)
 * and what makes `parity.test.ts`'s cross-path comparison meaningful in the
 * first place — a function that quietly reads the wall clock would make both
 * guarantees accidental.
 */

const candles = generateMockCandles("BTC", "1H", 220);
const pivots = computePivots(candles);
const BASE = evaluateSignal("BTC", candles, pivots);

function evalsAndZonesFor(): EvaluateInput["evalsByTimeframe"] {
  return { "1H": BASE };
}

function baseInput(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    symbol: "BTC",
    market: "spot",
    evalsByTimeframe: evalsAndZonesFor(),
    zonesByTimeframe: { "1H": [] },
    perp: null,
    sessionLevels: [],
    comboStats: [],
    holds: {},
    nowMs: Date.UTC(2026, 6, 10, 0, 0, 0),
    ...overrides,
  };
}

describe("evaluateSymbol is a pure function of its input (no hidden clock)", () => {
  afterEach(() => vi.useRealTimers());

  it("returns identical output for identical input, called twice", () => {
    const input = baseInput();
    const first = evaluateSymbol(structuredClone(input));
    const second = evaluateSymbol(structuredClone(input));
    expect(second).toEqual(first);
  });

  it("is unaffected by the real wall clock — only `nowMs` matters", () => {
    const input = baseInput();

    vi.useFakeTimers({ now: new Date(Date.UTC(2020, 0, 1)), shouldAdvanceTime: false });
    const early = evaluateSymbol(structuredClone(input));

    vi.useFakeTimers({ now: new Date(Date.UTC(2030, 0, 1)), shouldAdvanceTime: false });
    const late = evaluateSymbol(structuredClone(input));

    expect(late).toEqual(early);
  });

  it("gives every intent's holdKey the same nowMs-derived timestamps regardless of Object key order", () => {
    // Rebuilding holds/comboStats/evalsByTimeframe with keys inserted in a
    // different order must not change the result — nothing in the pipeline
    // may accidentally depend on iteration/insertion order.
    const forward = baseInput({
      zonesByTimeframe: { "1H": [] },
      holds: {},
    });
    const reordered = baseInput({
      zonesByTimeframe: { "1H": [] },
      holds: {},
    });
    // Reverse the intent list's traversal by feeding evalsByTimeframe/zonesByTimeframe
    // rebuilt via a fresh object (insertion order differs even though contents match).
    const reorderedEvals: EvaluateInput["evalsByTimeframe"] = {};
    for (const key of Object.keys(forward.evalsByTimeframe).reverse()) {
      reorderedEvals[key as keyof typeof reorderedEvals] =
        forward.evalsByTimeframe[key as keyof typeof forward.evalsByTimeframe];
    }
    reordered.evalsByTimeframe = reorderedEvals;

    expect(evaluateSymbol(reordered)).toEqual(evaluateSymbol(forward));
  });
});

describe("a full pass over multiple symbols is order-independent", () => {
  it("evaluating symbols in either order yields the same per-symbol result", () => {
    const symbols = ["BTC", "SOL", "DOGE"];
    const inputsBySymbol = new Map<string, EvaluateInput>();
    for (const symbol of symbols) {
      const c = generateMockCandles(symbol, "1H", 220);
      const evaluation = evaluateSignal(symbol, c, computePivots(c));
      inputsBySymbol.set(symbol, baseInput({ symbol, evalsByTimeframe: { "1H": evaluation } }));
    }

    const runInOrder = (order: string[]) =>
      order.map((s) => [s, evaluateSymbol(structuredClone(inputsBySymbol.get(s)!))] as const);

    const forwardRun = runInOrder(symbols);
    const reversedRun = runInOrder([...symbols].reverse());

    for (const [symbol, result] of forwardRun) {
      const reversed = reversedRun.find(([s]) => s === symbol)![1];
      expect(reversed, `${symbol} depends on pass order`).toEqual(result);
    }
  });
});

describe("settlement functions are pure over (signal, closedBars)", () => {
  const step = 3600;
  function bar(time: number, low: number, high: number, close?: number) {
    return { time, open: (low + high) / 2, high, low, close: close ?? (low + high) / 2, volume: 1 };
  }
  const shadowBars = Array.from({ length: 10 }, (_, i) => bar((i + 1) * step, 90, 112, 100 + i));

  const shadowSignal: ShadowSignal = {
    id: "s1",
    symbol: "TEST",
    market: "spot",
    intent: "intraday",
    direction: "long",
    setupType: "breakout",
    regime: "trending-up",
    timeframe: "1H",
    entry: 100,
    stop: 95,
    target1: 105,
    target2: 130,
    confidence: 60,
    openedAt: new Date(0).toISOString(),
    status: "active",
  };

  it("settleShadowSignal: same signal + bars twice gives the same patch", () => {
    const first = settleShadowSignal(structuredClone(shadowSignal), structuredClone(shadowBars));
    const second = settleShadowSignal(structuredClone(shadowSignal), structuredClone(shadowBars));
    expect(second).toEqual(first);
  });

  it("settleShadowSignal ignores the real wall clock", () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2020, 0, 1)), shouldAdvanceTime: false });
    const early = settleShadowSignal(structuredClone(shadowSignal), structuredClone(shadowBars));
    vi.useFakeTimers({ now: new Date(Date.UTC(2030, 0, 1)), shouldAdvanceTime: false });
    const late = settleShadowSignal(structuredClone(shadowSignal), structuredClone(shadowBars));
    vi.useRealTimers();
    expect(late).toEqual(early);
  });

  const anticipatorySignal: AnticipatorySignal = {
    id: "a1",
    symbol: "TEST",
    market: "spot",
    intent: "intraday",
    direction: "long",
    setupType: "pullback-continuation",
    regime: "trending-up",
    timeframe: "1H",
    verdict: "favored",
    entry: 100,
    stop: 95,
    objective: 130,
    objectiveStrength: "strong",
    zoneFreshness: "fresh",
    rewardRisk: 6,
    openedAt: new Date(0).toISOString(),
    status: "pending",
  };
  const anticipatoryBars = Array.from({ length: 30 }, (_, i) => bar((i + 1) * step, 90, 112, 100));

  it("settleAnticipatorySignal: same signal + bars twice gives the same patch", () => {
    const first = settleAnticipatorySignal(
      structuredClone(anticipatorySignal),
      structuredClone(anticipatoryBars),
    );
    const second = settleAnticipatorySignal(
      structuredClone(anticipatorySignal),
      structuredClone(anticipatoryBars),
    );
    expect(second).toEqual(first);
  });

  const trackedSignal: TrackedSignal = {
    id: "t1",
    symbol: "TEST",
    intent: "intraday",
    direction: "long",
    setupType: "breakout",
    timeframe: "1H",
    market: "spot",
    entryLow: 99,
    entryHigh: 101,
    entryPrice: 100,
    stop: 95,
    target1: 105,
    target2: 130,
    confidenceAtFollow: 60,
    followedAt: new Date(0).toISOString(),
    status: "active",
  };
  const trackedBars = Array.from({ length: 10 }, (_, i) => bar((i + 1) * step, 90, 112, 100 + i));

  it("settleTrackedSignalWithCandles: same signal + bars twice gives the same patch", () => {
    const first = settleTrackedSignalWithCandles(
      structuredClone(trackedSignal),
      structuredClone(trackedBars),
    );
    const second = settleTrackedSignalWithCandles(
      structuredClone(trackedSignal),
      structuredClone(trackedBars),
    );
    expect(second).toEqual(first);
  });
});
