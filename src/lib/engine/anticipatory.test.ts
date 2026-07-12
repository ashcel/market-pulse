import { describe, expect, it } from "vitest";

import {
  buildAnticipatorySignal,
  isOpenAnticipatoryStatus,
  settleAnticipatorySignal,
  summarizeAnticipatoryRecord,
  type AnticipatorySignal,
} from "./anticipatory";
import { INTENT_MAX_HOLD_BARS } from "./hysteresis";
import type { Candle } from "./types";
import { labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

/**
 * The Phase 0.5 fill model: a resting limit either fills (first closed-bar
 * touch, inclusive, at the limit price) or expires never-filled with no R;
 * once filled it walks stop-first with the fill bar unable to credit the
 * objective. These conventions are EDR 0010's — structural, never tuned.
 */

const HOUR = 3600;

function bar(time: number, low: number, high: number, close?: number): Candle {
  return { time, open: (low + high) / 2, high, low, close: close ?? (low + high) / 2, volume: 1 };
}

/** A pending long: limit 100, stop 95, objective 115, opened at t=0, 1H bars. */
function pendingLong(overrides: Partial<AnticipatorySignal> = {}): AnticipatorySignal {
  return {
    id: "t-1",
    symbol: "TEST",
    market: "spot",
    intent: "intraday", // 24-bar horizon
    direction: "long",
    setupType: "pullback-continuation",
    regime: "trending-up",
    timeframe: "1H",
    verdict: "wait",
    entry: 100,
    stop: 95,
    objective: 115,
    objectiveStrength: "weak",
    zoneFreshness: "fresh",
    rewardRisk: 3,
    openedAt: new Date(0).toISOString(),
    status: "pending",
    ...overrides,
  };
}

/** n bars from t=1h that never reach down to the limit (stay 105–110). */
function awayBars(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => bar((i + 1) * HOUR, 105, 110));
}

describe("settleAnticipatorySignal — pending", () => {
  it("returns null while the limit rests and the horizon is incomplete", () => {
    expect(settleAnticipatorySignal(pendingLong(), awayBars(5))).toBeNull();
  });

  it("closes never-filled, without R, once the horizon completes untouched", () => {
    const maxBars = INTENT_MAX_HOLD_BARS.intraday;
    const patch = settleAnticipatorySignal(pendingLong(), awayBars(maxBars));
    expect(patch).toEqual({
      status: "never-filled",
      closedAt: new Date((maxBars * HOUR + HOUR) * 1000).toISOString(),
    });
    expect(patch!.resultR).toBeUndefined();
  });

  it("a touch at exactly the limit price fills (inclusive)", () => {
    const patch = settleAnticipatorySignal(pendingLong(), [bar(HOUR, 100, 108)]);
    expect(patch?.status).toBe("filled");
    expect(patch?.filledAt).toBe(new Date(HOUR * 1000).toISOString());
  });

  it("ignores bars at or before adoption — the forming bar cannot fill", () => {
    expect(settleAnticipatorySignal(pendingLong(), [bar(0, 90, 108)])).toBeNull();
  });

  it("a fill after the pending horizon does not count — the limit was cancelled", () => {
    const maxBars = INTENT_MAX_HOLD_BARS.intraday;
    const bars = [...awayBars(maxBars), bar((maxBars + 1) * HOUR, 99, 104)];
    const patch = settleAnticipatorySignal(pendingLong(), bars);
    expect(patch?.status).toBe("never-filled");
  });

  it("resolves fill and outcome in one pass when the batch already contains both", () => {
    const bars = [bar(HOUR, 99, 104), bar(2 * HOUR, 103, 116)];
    const patch = settleAnticipatorySignal(pendingLong(), bars);
    expect(patch?.status).toBe("objective-hit");
    expect(patch?.filledAt).toBe(new Date(HOUR * 1000).toISOString());
    expect(patch?.closePrice).toBe(115);
    // R measured from the limit: (115 − 100) / (100 − 95) = 3.
    expect(patch?.resultR).toBe(3);
  });
});

describe("settleAnticipatorySignal — the fill bar", () => {
  it("stops out on the fill bar itself when it sweeps through the stop", () => {
    const patch = settleAnticipatorySignal(pendingLong(), [bar(HOUR, 94, 106)]);
    expect(patch?.status).toBe("stopped-out");
    expect(patch?.filledAt).toBe(new Date(HOUR * 1000).toISOString());
    expect(patch?.resultR).toBe(-1);
  });

  it("gives the fill bar no objective credit — the print may predate the fill", () => {
    // One huge bar touches the limit AND the objective: stays open.
    const patch = settleAnticipatorySignal(pendingLong(), [bar(HOUR, 99, 120)]);
    expect(patch?.status).toBe("filled");
    expect(patch?.closePrice).toBeUndefined();
    // The very next bar reaching the objective does count.
    const next = settleAnticipatorySignal(
      { ...pendingLong(), ...patch, status: "filled" } as AnticipatorySignal,
      [bar(HOUR, 99, 120), bar(2 * HOUR, 110, 116)],
    );
    expect(next?.status).toBe("objective-hit");
  });

  it("checks the stop before the objective on every later bar (walk convention)", () => {
    const fill = settleAnticipatorySignal(pendingLong(), [bar(HOUR, 99, 104)]);
    const both = settleAnticipatorySignal(
      { ...pendingLong(), ...fill, status: "filled" } as AnticipatorySignal,
      [bar(HOUR, 99, 104), bar(2 * HOUR, 94, 116)],
    );
    expect(both?.status).toBe("stopped-out");
  });
});

describe("settleAnticipatorySignal — filled positions", () => {
  const filled = (): AnticipatorySignal => ({
    ...pendingLong(),
    status: "filled",
    filledAt: new Date(HOUR * 1000).toISOString(),
  });

  it("expires at the hold horizon with R from the last close", () => {
    const maxBars = INTENT_MAX_HOLD_BARS.intraday;
    const bars = Array.from({ length: maxBars }, (_, i) => bar((i + 1) * HOUR, 101, 106, 102.5));
    const patch = settleAnticipatorySignal(filled(), bars);
    expect(patch?.status).toBe("expired");
    // (102.5 − 100) / 5 = 0.5.
    expect(patch?.resultR).toBe(0.5);
  });

  it("returns null while the position is open and the horizon incomplete", () => {
    expect(
      settleAnticipatorySignal(filled(), [bar(HOUR, 101, 106), bar(2 * HOUR, 102, 107)]),
    ).toBeNull();
  });

  it("mirrors for shorts", () => {
    const short = pendingLong({
      direction: "short",
      entry: 100,
      stop: 105,
      objective: 85,
    });
    const fill = settleAnticipatorySignal(short, [bar(HOUR, 96, 101)]);
    expect(fill?.status).toBe("filled");
    const win = settleAnticipatorySignal(
      { ...short, ...fill, status: "filled" } as AnticipatorySignal,
      [bar(HOUR, 96, 101), bar(2 * HOUR, 84, 98)],
    );
    expect(win?.status).toBe("objective-hit");
    expect(win?.resultR).toBe(3);
  });

  it("is append-only: a terminal patch is never contradicted by longer batches", () => {
    const signal = pendingLong();
    const full = [bar(HOUR, 99, 104), bar(2 * HOUR, 103, 116), bar(3 * HOUR, 90, 105)];
    let settled: AnticipatorySignal = signal;
    let terminal: Partial<AnticipatorySignal> | null = null;
    for (let n = 1; n <= full.length; n++) {
      const patch = settleAnticipatorySignal(settled, full.slice(0, n));
      if (patch) settled = { ...settled, ...patch } as AnticipatorySignal;
      if (terminal) {
        expect(patch).toBeNull(); // terminal states never re-patch
      } else if (patch && !isOpenAnticipatoryStatus(settled.status)) {
        terminal = patch;
        expect(patch.status).toBe("objective-hit"); // bar 2, before bar 3's stop sweep
      }
    }
    expect(terminal).not.toBeNull();
  });
});

describe("buildAnticipatorySignal / summarize", () => {
  it("returns null without a plan and freezes the plan when present", () => {
    const base = {
      intent: "intraday",
      verdict: "wait",
      definition: { executionTimeframe: "1H" },
      execution: { setupType: "pullback-continuation", regime: "trending-up" },
      anticipatoryPlan: null,
    } as never;
    expect(buildAnticipatorySignal(base, "eth", "spot", "now")).toBeNull();

    const withPlan = {
      ...(base as object),
      anticipatoryPlan: {
        direction: "long",
        zone: {
          kind: "demand",
          priceLow: 95,
          priceHigh: 100,
          startTime: 1,
          endTime: 2,
          freshness: "fresh",
        },
        entry: 100,
        stop: 95,
        objective: { price: 115, strength: "weak" },
        riskPerUnit: 5,
        rewardPerUnit: 15,
        rewardRisk: 3,
        entryPosition: "discount",
      },
    } as never;
    const input = buildAnticipatorySignal(withPlan, "eth", "spot", "2026-07-10T00:00:00.000Z");
    expect(input).toMatchObject({
      symbol: "ETH",
      direction: "long",
      entry: 100,
      stop: 95,
      objective: 115,
      objectiveStrength: "weak",
      zoneFreshness: "fresh",
      rewardRisk: 3,
      verdict: "wait",
      timeframe: "1H",
    });
  });

  it("summarizes fill rate over decided fills and R over settled positions only", () => {
    const s = (status: AnticipatorySignal["status"], resultR?: number): AnticipatorySignal => ({
      ...pendingLong(),
      status,
      resultR,
    });
    const summary = summarizeAnticipatoryRecord([
      s("pending"),
      s("filled"),
      s("never-filled"),
      s("never-filled"),
      s("objective-hit", 3),
      s("stopped-out", -1),
      s("expired", 0.5),
    ]);
    expect(summary.total).toBe(7);
    expect(summary.pending).toBe(1);
    expect(summary.open).toBe(1);
    expect(summary.neverFilled).toBe(2);
    expect(summary.filled).toBe(4); // 1 open + 3 settled
    expect(summary.fillRate).toBe(round1((4 / 6) * 100));
    expect(summary.settled).toBe(3);
    expect(summary.wins).toBe(2); // positive R: objective-hit and expired at +0.5
    expect(summary.losses).toBe(1);
    expect(summary.averageR).toBe(round2((3 - 1 + 0.5) / 3));
    expect(summary.lowSample).toBe(true);
  });
});

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

describe("dreimann zec-sl through the fill model", () => {
  // The instructive loss, graded by the harness exactly as it played out.
  const fixture = loadDreimannFixture("zec-sl");
  const bars = fixture.series["4h"]!;
  const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
  // Adopted just before the labeled fill bar so that bar can fill it.
  const openedAt = new Date((entryTime - 1) * 1000).toISOString();

  const traderPlan = (): AnticipatorySignal => ({
    ...pendingLong({
      symbol: "ZECUSDT",
      intent: "swing", // 42 × 4H
      timeframe: "4H",
      entry: fixture.labels.entry.price, // 450.49
      stop: fixture.labels.stop.price, // 446.05 — inside the POI's noise
      objective: fixture.labels.objective.price, // 476.9
      openedAt,
    }),
  });

  it("grades the trader's actual plan: filled and stopped on the same 4h bar", () => {
    const patch = settleAnticipatorySignal(traderPlan(), bars);
    // The 04:00Z Jul 7 bar wicked to 443.82: through the limit AND the stop.
    expect(patch?.status).toBe("stopped-out");
    expect(patch?.filledAt).toBe(new Date(entryTime * 1000).toISOString());
    expect(patch?.resultR).toBe(-1);
  });

  it("grades the same entry with the EDR-0009 stop outside the noise: objective hit", () => {
    // Same limit, stop below the sweep's 443.82 extreme (the distal-edge
    // lesson): the position survives the wick and the 12:00Z rally prints
    // the 476.9 objective — 'would have reached TP without stop', reproduced.
    const survivable = { ...traderPlan(), stop: 443.0 };
    const patch = settleAnticipatorySignal(survivable, bars);
    expect(patch?.status).toBe("objective-hit");
    expect(patch?.resultR).toBeGreaterThan(3);
  });
});
