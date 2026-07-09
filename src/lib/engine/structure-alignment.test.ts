import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { evaluateSignal } from "./quant";
import type { Candle } from "./types";
import type { SignalEvaluation } from "./quant";

/**
 * Decision-evidence fixtures for the "Structure alignment" component: the
 * swing-structure read (HH/HL/LH/LL + BOS/CHoCH) must score the setup the
 * engine actually classifies, and fighting the structure must hard-veto the
 * trade the same way fighting a confirmed regime does. Candle shapes are
 * hand-built so the pivots — and therefore the structure — are exact.
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

function evaluate(closes: number[], volumes: number[] = []): SignalEvaluation {
  const candles = createCandles(closes, volumes);
  return evaluateSignal("TEST", candles, computePivots(candles));
}

function structureComponent(evaluation: SignalEvaluation) {
  const component = evaluation.components.find((c) => c.name === "Structure alignment");
  expect(component).toBeDefined();
  return component!;
}

const STRUCTURE_VETO = "Setup direction fights the swing-structure read.";

// Zigzag base whose confirmed pivots read HH (95→100 highs) and HL (92→96
// lows): an unambiguous swing uptrend. The tail climbs without confirming
// further pivots, leaving room to end the series as a long or a short setup.
const UPTREND_BASE = [
  90,
  91,
  92,
  93,
  94,
  95, // ramp to the first swing high (95)
  94,
  93,
  92, // first swing low (92)
  93,
  95,
  97,
  99,
  100, // higher high (100)
  99,
  98,
  97,
  96, // higher low (96)
  96.5,
  97,
  97.5,
  98,
  98.5,
  99,
  99.2,
  99.3,
  99.4,
  99.5, // unconfirmed climb
];

function breakoutVolumes(length: number): number[] {
  const volumes = Array.from({ length: length - 1 }, () => 1000);
  volumes.push(1500); // 1.5x the 20-bar average: clears the breakout gate
  return volumes;
}

describe("Structure alignment component", () => {
  it("passes a long that trades with a HH/HL swing uptrend", () => {
    const closes = [...UPTREND_BASE, 99.8, 101]; // breakout close above the 100 high
    const evaluation = evaluate(closes, breakoutVolumes(closes.length));

    expect(evaluation.direction).toBe("long");
    expect(evaluation.structure.trend).toBe("uptrend");
    const component = structureComponent(evaluation);
    expect(component.status).toBe("pass");
    expect(component.score).toBeGreaterThan(0);
    expect(evaluation.noTradeReasons).not.toContain(STRUCTURE_VETO);
  });

  it("fails and hard-vetoes a short that fights a HH/HL swing uptrend", () => {
    // Spike above the 100 swing high, close back under: failed-breakout short
    // — against a structure still printing higher highs and higher lows.
    const closes = [...UPTREND_BASE, 101, 98];
    const evaluation = evaluate(closes);

    expect(evaluation.setupType).toBe("failed-breakout");
    expect(evaluation.direction).toBe("short");
    expect(evaluation.structure.trend).toBe("uptrend");
    const component = structureComponent(evaluation);
    expect(component.status).toBe("fail");
    expect(component.score).toBeLessThan(0);
    expect(evaluation.noTradeReasons).toContain(STRUCTURE_VETO);
    expect(evaluation.decision).not.toBe("short-candidate");
  });

  it("is neutral with a zero score when there is no directional setup", () => {
    // Under 30 bars classifySetup declines to classify: direction "none".
    const evaluation = evaluate(Array.from({ length: 20 }, () => 100));

    expect(evaluation.direction).toBe("none");
    const component = structureComponent(evaluation);
    expect(component.status).toBe("neutral");
    expect(component.score).toBe(0);
  });

  it("warns when structure is range-bound with no live break either way", () => {
    // One swing high and one swing low (both unlabeled — nothing to compare
    // against), then an unconfirmed climb into a breakout: a long with no
    // structural sequence behind it.
    const closes = [
      90,
      91,
      92,
      93,
      94,
      95, // lone swing high
      94,
      93,
      92, // lone swing low
      ...Array.from({ length: 19 }, (_, i) => 92.4 + i * 0.4), // unconfirmed climb
      99.8,
      101,
    ];
    const evaluation = evaluate(closes, breakoutVolumes(closes.length));

    expect(evaluation.direction).toBe("long");
    expect(evaluation.structure.trend).toBe("range");
    expect(evaluation.structure.event).toBeNull();
    const component = structureComponent(evaluation);
    expect(component.status).toBe("warning");
    expect(evaluation.noTradeReasons).not.toContain(STRUCTURE_VETO);
  });

  it("passes a long whose latest live break is a CHoCH in its favor", () => {
    // LH/LL downtrend, then a higher high breaks it (CHoCH): the trend reads
    // range but the freshest structural evidence points long — the early turn.
    const closes = [
      96,
      98,
      99,
      100, // first swing high (100)
      97,
      94,
      90, // first swing low (90)
      92,
      95,
      97, // lower high (97)
      94,
      91,
      85, // lower low (85): downtrend confirmed
      88,
      92,
      96,
      100,
      103,
      105, // higher high (105): CHoCH against the downtrend
      104,
      103,
      102.5,
      102,
      101.8,
      101.5,
      101.3,
      101,
      100.8,
      100.5, // drift, no new pivots
      106, // breakout close above the 105 high
    ];
    const evaluation = evaluate(closes, breakoutVolumes(closes.length));

    expect(evaluation.direction).toBe("long");
    expect(evaluation.structure.trend).toBe("range");
    expect(evaluation.structure.event).toBe("choch");
    const component = structureComponent(evaluation);
    expect(component.status).toBe("pass");
    expect(component.explanation).toContain("CHoCH");
    expect(evaluation.noTradeReasons).not.toContain(STRUCTURE_VETO);
  });

  it("fails and hard-vetoes a long whose latest live break is a CHoCH against it", () => {
    // HH/HL uptrend, then a lower low breaks it (CHoCH short), then a rally
    // into a breakout long: the freshest structural evidence points short.
    const closes = [
      93,
      92,
      91,
      90, // first swing low (90)
      93,
      96,
      100, // first swing high (100)
      98,
      96,
      95, // higher low (95)
      97,
      100,
      105, // higher high (105): uptrend confirmed
      102,
      98,
      92,
      88, // lower low (88): CHoCH against the uptrend
      92,
      96,
      100,
      101,
      101.5,
      102,
      102.5,
      103,
      103.5,
      104,
      104.2,
      104.5, // unconfirmed rally
      106, // breakout close above the 105 high
    ];
    const evaluation = evaluate(closes, breakoutVolumes(closes.length));

    expect(evaluation.direction).toBe("long");
    expect(evaluation.structure.trend).toBe("range");
    expect(evaluation.structure.event).toBe("choch");
    const component = structureComponent(evaluation);
    expect(component.status).toBe("fail");
    expect(evaluation.noTradeReasons).toContain(STRUCTURE_VETO);
    expect(evaluation.decision).toBe("no-trade");
  });
});
