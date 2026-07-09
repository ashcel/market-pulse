import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { classifyRegime, classifySetup, currentSweep, evaluateSignal } from "./quant";
import type { Candle } from "./types";
import type { SignalEvaluation } from "./quant";

/**
 * Decision-evidence fixtures for liquidity integration: a recent sweep of a
 * pool must classify the setup (raid of buy-side stops → failed-breakout
 * short; raid of sell-side stops → capitulation-reversal long), and entering
 * toward an intact pool must warn and veto. Wicks are patched onto derived
 * candles so the sweep — wick through the level, close back inside — is exact.
 */

// Same candle factory as breakout.test.ts: 1H bars, high/low derived from close.
function createCandles(closes: number[], volumes: number[] = []): Candle[] {
  const baseTime = 1000000;
  const step = 3600;
  return closes.map((close, i) => ({
    time: baseTime + i * step,
    open: close * 0.995,
    high: close * 1.001,
    low: close * 0.99,
    close,
    volume: volumes[i] ?? 1000,
  }));
}

function patchCandle(candles: Candle[], index: number, patch: Partial<Candle>): Candle[] {
  return candles.map((c, i) => (i === index ? { ...c, ...patch } : c));
}

function setupFor(candles: Candle[]) {
  return classifySetup(candles, computePivots(candles), classifyRegime(candles));
}

function evaluate(candles: Candle[]): SignalEvaluation {
  return evaluateSignal("TEST", candles, computePivots(candles));
}

// Double top at 100 (equal swing highs → an intact BSL pool at 100.1) over a
// HL low sequence, then a quiet drift below the level. Without any sweep the
// classifier reads the higher low: higher-low-continuation, a long.
const DOUBLE_TOP_BASE = [
  90,
  92,
  94,
  96,
  100, // first swing high (100)
  97,
  95,
  93,
  92, // swing low (92)
  94,
  96,
  98,
  100, // equal high (100): BSL pool completes
  98,
  97,
  96,
  95, // higher low (95)
  95.5,
  96,
  96.5, // recovery, unconfirmed
  96.6,
  96.7,
  96.8,
  96.9,
  97.0,
  97.1,
  97.2,
  97.3,
  97.4, // drift below the pool
];

// Double bottom at 90 (equal swing lows → an intact SSL pool at 89.1) under a
// LH high sequence, then a quiet drift above the level. Without any sweep the
// classifier reads the lower high: lower-high-rejection, a short.
const DOUBLE_BOTTOM_BASE = [
  110,
  105,
  100,
  95,
  90, // first swing low (90)
  93,
  96,
  98,
  100, // swing high (100)
  97,
  95,
  92,
  90, // equal low (90): SSL pool completes
  92,
  94,
  95,
  96, // lower high (96)
  95.5,
  95,
  94.5, // fade, unconfirmed
  94.4,
  94.3,
  94.2,
  94.1,
  94.0,
  93.9,
  93.8,
  93.7,
  93.6, // drift above the pool
];

describe("sweeps classify setups", () => {
  it("classifies a fresh buy-side sweep as failed-breakout (short)", () => {
    // Final bar wicks through the 100.1 pool and closes back under.
    const candles = patchCandle(createCandles([...DOUBLE_TOP_BASE, 99]), 29, { high: 101.5 });
    const evaluation = evaluate(candles);

    expect(evaluation.liquiditySweeps).toHaveLength(1);
    expect(evaluation.liquiditySweeps[0].side).toBe("bsl");
    expect(evaluation.setupType).toBe("failed-breakout");
    expect(evaluation.direction).toBe("short");
  });

  it("reads the same shape without the raid wick as the continuation long", () => {
    // Control for the test above: identical closes, no penetration — the raw
    // chain's higher-low read stands, proving the sweep drove the short.
    const candles = createCandles([...DOUBLE_TOP_BASE, 99]);
    const evaluation = evaluate(candles);

    expect(evaluation.liquiditySweeps).toHaveLength(0);
    expect(evaluation.setupType).toBe("higher-low-continuation");
    expect(evaluation.direction).toBe("long");
  });

  it("classifies a fresh sell-side sweep as capitulation-reversal (long)", () => {
    // Final bar wicks through the 89.1 pool and closes back above. Without
    // the sweep branch this shape reads lower-high-rejection — a short.
    const candles = patchCandle(createCandles([...DOUBLE_BOTTOM_BASE, 91]), 29, { low: 88.5 });
    const evaluation = evaluate(candles);

    expect(evaluation.liquiditySweeps).toHaveLength(1);
    expect(evaluation.liquiditySweeps[0].side).toBe("ssl");
    expect(evaluation.setupType).toBe("capitulation-reversal");
    expect(evaluation.direction).toBe("long");
  });

  it("ignores a sweep older than the recency window", () => {
    // The raid happened at bar 24 — five closed bars back. The sweep is real
    // and recorded, but it is history, not a trigger.
    const candles = patchCandle(createCandles([...DOUBLE_TOP_BASE, 99]), 24, { high: 101.5 });
    const evaluation = evaluate(candles);

    expect(evaluation.liquiditySweeps).toHaveLength(1);
    expect(evaluation.setupType).not.toBe("failed-breakout");
    expect(evaluation.setupType).toBe("higher-low-continuation");
  });

  it("lets a fresh breakout acceptance outrank a recent sweep", () => {
    // Raid two bars back, then the current bar closes above everything with
    // volume: acceptance on the newest bar wins over the older raid.
    const volumes = Array.from({ length: 30 }, () => 1000);
    volumes[29] = 1500;
    const candles = patchCandle(createCandles([...DOUBLE_TOP_BASE, 102], volumes), 27, {
      high: 101.5,
    });

    expect(setupFor(candles)).toBe("breakout");
  });
});

describe("currentSweep", () => {
  it("returns the latest sweep while it is inside the recency window", () => {
    const candles = patchCandle(createCandles([...DOUBLE_TOP_BASE, 99]), 29, { high: 101.5 });
    const evaluation = evaluate(candles);

    expect(currentSweep(evaluation.liquiditySweeps, candles)).toBe(evaluation.liquiditySweeps[0]);
  });

  it("returns null once the sweep ages past the recency window", () => {
    // Same rule setup classification applies (see "ignores a sweep older than
    // the recency window") — a raid five bars back is recorded but not live.
    const candles = patchCandle(createCandles([...DOUBLE_TOP_BASE, 99]), 24, { high: 101.5 });
    const evaluation = evaluate(candles);

    expect(evaluation.liquiditySweeps).toHaveLength(1);
    expect(currentSweep(evaluation.liquiditySweeps, candles)).toBeNull();
  });

  it("returns null with no sweeps or no candles", () => {
    const candles = createCandles([...DOUBLE_TOP_BASE, 99]);
    const evaluation = evaluate(patchCandle(candles, 29, { high: 101.5 }));

    expect(currentSweep([], candles)).toBeNull();
    expect(currentSweep(evaluation.liquiditySweeps, [])).toBeNull();
  });
});

describe("liquidity context component", () => {
  function liquidityComponent(evaluation: SignalEvaluation) {
    const component = evaluation.components.find((c) => c.name === "Liquidity context");
    expect(component).toBeDefined();
    return component!;
  }

  it("warns and vetoes a long entering just below an intact buy-side pool", () => {
    // Close 99.8 against the intact pool at 100.1 — 0.3% away, inside the
    // proximity window: the textbook pre-raid entry.
    const evaluation = evaluate(createCandles([...DOUBLE_TOP_BASE, 99.8]));

    expect(evaluation.direction).toBe("long");
    const component = liquidityComponent(evaluation);
    expect(component.status).toBe("warning");
    expect(evaluation.noTradeReasons).toContain(
      "Long entry sits just below an intact buy-side liquidity pool.",
    );
    expect(evaluation.decision).toBe("no-trade");
  });

  it("passes a long backed by a fresh sell-side sweep", () => {
    const candles = patchCandle(createCandles([...DOUBLE_BOTTOM_BASE, 91]), 29, { low: 88.5 });
    const evaluation = evaluate(candles);

    expect(evaluation.direction).toBe("long");
    const component = liquidityComponent(evaluation);
    expect(component.status).toBe("pass");
    expect(component.explanation).toContain("swept");
  });

  it("stays neutral with a zero score when there is no directional setup", () => {
    const evaluation = evaluate(createCandles(Array.from({ length: 20 }, () => 100)));

    expect(evaluation.direction).toBe("none");
    const component = liquidityComponent(evaluation);
    expect(component.status).toBe("neutral");
    expect(component.score).toBe(0);
  });
});
