import { describe, expect, it } from "vitest";

import { INTENT_MAX_HOLD_BARS } from "./hysteresis";
import { STEP_SECONDS } from "./mock-candles";
import { settleShadowSignal, type ShadowSignal } from "./shadow";
import {
  isOpenAnticipatoryStatus,
  settleAnticipatorySignal,
  type AnticipatorySignal,
} from "./anticipatory";
import { settleTrackedSignalWithCandles, walkExitLevels, type TrackedSignal } from "./tracker";
import type { Candle } from "./types";

/**
 * WS2 — settlement invariants, run over many random price paths rather than
 * a handful of hand-picked bars. `shadow.test.ts`/`anticipatory.test.ts` cover
 * the specific EDR-0010 conventions with worked examples; this suite instead
 * asks "does the *contract* hold no matter what the market does": a settled
 * result's R sign always agrees with its terminal status, `expired` never
 * fires before the intent's hold horizon, and a bar that satisfies both a
 * stop and a target resolves as a stop (the conservative read). No test here
 * existed for `tracker.ts`'s `walkExitLevels`/`settleTrackedSignalWithCandles`
 * before this suite.
 */

// Deterministic PRNG (mulberry32) — reproducible across CI runs, no test flake.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWalk(
  rand: () => number,
  count: number,
  startPrice: number,
  stepSec: number,
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const change = (rand() - 0.5) * open * 0.05;
    const close = Math.max(0.01, open + change);
    const wick = Math.abs(change) * (0.5 + rand());
    const high = Math.max(open, close) + wick * rand();
    const low = Math.max(0.01, Math.min(open, close) - wick * rand());
    candles.push({ time: (i + 1) * stepSec, open, high, low, close, volume: 1 });
    price = close;
  }
  return candles;
}

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const STEP = STEP_SECONDS["1H"];
const MAX_BARS = INTENT_MAX_HOLD_BARS.intraday; // 24

function baseShadow(direction: "long" | "short"): ShadowSignal {
  const long = direction === "long";
  return {
    id: "s",
    symbol: "TEST",
    market: "spot",
    intent: "intraday",
    direction,
    setupType: "breakout",
    regime: long ? "trending-up" : "trending-down",
    timeframe: "1H",
    entry: 100,
    stop: long ? 95 : 105,
    target1: long ? 105 : 95,
    target2: long ? 110 : 90,
    confidence: 60,
    openedAt: new Date(0).toISOString(),
    status: "active",
  };
}

describe("shadow settlement invariants (property-based, 60 random walks x 2 directions)", () => {
  for (const seed of SEEDS) {
    for (const direction of ["long", "short"] as const) {
      it(`seed=${seed} direction=${direction}`, () => {
        const rand = mulberry32(seed * (direction === "long" ? 1 : -1));
        // maxBars + margin: settleShadowSignal always terminates (hits a level
        // or expires at maxBars) once given at least maxBars qualifying bars.
        const bars = randomWalk(rand, MAX_BARS + 5, 100, STEP);
        const signal = baseShadow(direction);
        const patch = settleShadowSignal(signal, bars);

        expect(patch, "must terminate within maxBars + margin bars").not.toBeNull();
        if (!patch) return;
        expect(patch.status).not.toBe("active");
        expect(Number.isFinite(patch.resultR)).toBe(true);

        if (patch.status === "target1-hit" || patch.status === "target2-hit") {
          expect(patch.resultR).toBeGreaterThan(0);
        }
        if (patch.status === "stopped-out") {
          expect(patch.resultR).toBeLessThan(0);
        }

        // Horizon bound: closedAt can never land beyond maxBars bars past open
        // (+1 step for the "closed at bar end" convention) — no runaway hold.
        const closedSec = Date.parse(patch.closedAt!) / 1000;
        expect(closedSec).toBeLessThanOrEqual(MAX_BARS * STEP + STEP);
      });
    }
  }

  it("expired only fires at/after the intraday horizon (24 bars), never earlier", () => {
    // A flat walk that never reaches stop/target1/target2 for the whole window.
    const bars = Array.from({ length: MAX_BARS + 5 }, (_, i) => ({
      time: (i + 1) * STEP,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    }));
    const patch = settleShadowSignal(baseShadow("long"), bars);
    expect(patch?.status).toBe("expired");
    const closedSec = Date.parse(patch!.closedAt!) / 1000;
    expect(closedSec).toBe(MAX_BARS * STEP + STEP);
  });

  it("a bar that satisfies both the stop and a target resolves as a stop (conservative ordering)", () => {
    const signal = baseShadow("long"); // entry 100, stop 95, target1 105, target2 110
    const bothTouched: Candle = {
      time: STEP,
      open: 100,
      high: 111,
      low: 94,
      close: 100,
      volume: 1,
    };
    const patch = settleShadowSignal(signal, [bothTouched]);
    expect(patch?.status).toBe("stopped-out");
    expect(patch?.resultR).toBeLessThan(0);
  });
});

function basePendingAnticipatory(direction: "long" | "short"): AnticipatorySignal {
  const long = direction === "long";
  return {
    id: "a",
    symbol: "TEST",
    market: "spot",
    intent: "intraday",
    direction,
    setupType: "pullback-continuation",
    regime: long ? "trending-up" : "trending-down",
    timeframe: "1H",
    verdict: "favored",
    entry: 100, // the resting limit
    stop: long ? 90 : 110,
    objective: long ? 130 : 70,
    objectiveStrength: "strong",
    zoneFreshness: "fresh",
    rewardRisk: 3,
    openedAt: new Date(0).toISOString(),
    status: "pending",
  };
}

describe("anticipatory settlement invariants (property-based, 60 random walks x 2 directions)", () => {
  for (const seed of SEEDS) {
    for (const direction of ["long", "short"] as const) {
      it(`seed=${seed} direction=${direction}`, () => {
        const rand = mulberry32(seed * 1000 + (direction === "long" ? 1 : 2));
        // 2*maxBars + margin: worst case the fill lands on the last bar of the
        // pre-fill scan window, leaving a full maxBars for the position walk
        // to resolve (touch or expire) — see settleAnticipatorySignal.
        const bars = randomWalk(rand, MAX_BARS * 2 + 20, 100, STEP);
        const signal = basePendingAnticipatory(direction);
        const patch = settleAnticipatorySignal(signal, bars);

        expect(patch, "must reach a terminal state given 2x the horizon").not.toBeNull();
        if (!patch?.status) return;
        expect(isOpenAnticipatoryStatus(patch.status)).toBe(false);

        if (patch.status === "never-filled") {
          expect(patch.resultR).toBeUndefined();
          expect(patch.filledAt).toBeUndefined();
        }
        if (patch.status === "objective-hit") {
          expect(patch.resultR).toBeGreaterThan(0);
          expect(patch.filledAt).toBeDefined();
        }
        if (patch.status === "stopped-out") {
          expect(patch.resultR).toBeLessThan(0);
          expect(patch.filledAt).toBeDefined();
        }
        if (patch.status === "expired") {
          expect(Number.isFinite(patch.resultR)).toBe(true);
          expect(patch.filledAt).toBeDefined();
        }
      });
    }
  }

  it("never-filled only fires at/after the horizon with no touch of the limit", () => {
    // Drifts straight up, away from the long limit at 100 — never touches it
    // (starts a full point clear of the limit so the first bar's low doesn't
    // land exactly on the inclusive touch boundary).
    const bars = Array.from({ length: MAX_BARS + 5 }, (_, i) => ({
      time: (i + 1) * STEP,
      open: 101 + i,
      high: 102 + i,
      low: 101 + i,
      close: 101 + i,
      volume: 1,
    }));
    const patch = settleAnticipatorySignal(basePendingAnticipatory("long"), bars);
    expect(patch?.status).toBe("never-filled");
    const closedSec = Date.parse(patch!.closedAt!) / 1000;
    expect(closedSec).toBe(MAX_BARS * STEP + STEP);
  });
});

function baseTracked(direction: "long" | "short"): TrackedSignal {
  const long = direction === "long";
  return {
    id: "t",
    symbol: "TEST",
    intent: "intraday",
    direction,
    setupType: "breakout",
    timeframe: "1H",
    market: "spot",
    entryLow: 99,
    entryHigh: 101,
    entryPrice: 100,
    stop: long ? 95 : 105,
    target1: long ? 105 : 95,
    target2: long ? 110 : 90,
    confidenceAtFollow: 60,
    followedAt: new Date(0).toISOString(),
    status: "active",
  };
}

describe("tracked-signal (walkExitLevels) invariants — no prior coverage of tracker.ts existed", () => {
  for (const seed of SEEDS) {
    for (const direction of ["long", "short"] as const) {
      it(`seed=${seed} direction=${direction}`, () => {
        const rand = mulberry32(seed * 37 + (direction === "long" ? 3 : 4));
        const bars = randomWalk(rand, MAX_BARS + 5, 100, STEP);
        const patch = settleTrackedSignalWithCandles(baseTracked(direction), bars);
        if (!patch) return; // a walk that never touches any level is valid — skip

        expect(Number.isFinite(patch.resultR)).toBe(true);
        if (patch.status === "target1-hit" || patch.status === "target2-hit") {
          expect(patch.resultR).toBeGreaterThan(0);
        }
        if (patch.status === "stopped-out") {
          expect(patch.resultR).toBeLessThan(0);
        }
      });
    }
  }

  it("a bar that satisfies both the stop and target2 resolves as a stop (conservative ordering)", () => {
    const bothTouched: Candle = {
      time: STEP,
      open: 100,
      high: 111,
      low: 94,
      close: 100,
      volume: 1,
    };
    const event = walkExitLevels(
      { direction: "long", entry: 100, stop: 95, target1: 105, target2: 110 },
      [bothTouched],
    );
    expect(event?.status).toBe("stopped-out");
    expect(event?.resultR).toBeLessThan(0);
  });

  it("target2 is preferred over target1 when both are touched in the same bar", () => {
    const bothTargets: Candle = {
      time: STEP,
      open: 100,
      high: 111,
      low: 99,
      close: 100,
      volume: 1,
    };
    const event = walkExitLevels(
      { direction: "long", entry: 100, stop: 95, target1: 105, target2: 110 },
      [bothTargets],
    );
    expect(event?.status).toBe("target2-hit");
    expect(event?.resultR).toBeGreaterThan(0);
  });
});
