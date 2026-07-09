import { describe, expect, it } from "vitest";

import { computeMarketStructure } from "./structure";
import type { PivotPoint } from "./types";

// Build a pivot sequence from [kind, price] pairs with monotonic times, so the
// tests read as the swing sequence a trader would see left-to-right.
function pivots(...steps: [PivotPoint["kind"], number][]): PivotPoint[] {
  return steps.map(([kind, price], i) => ({ time: i + 1, price, kind }));
}

describe("computeMarketStructure", () => {
  it("labels an uptrend as higher highs and higher lows", () => {
    const s = computeMarketStructure(
      pivots(["low", 10], ["high", 20], ["low", 12], ["high", 24], ["low", 15]),
    );

    expect(s.lastHigh?.label).toBe("HH");
    expect(s.lastLow?.label).toBe("HL");
    expect(s.trend).toBe("uptrend");
  });

  it("labels a downtrend as lower highs and lower lows", () => {
    const s = computeMarketStructure(
      pivots(["high", 30], ["low", 20], ["high", 26], ["low", 15], ["high", 22]),
    );

    expect(s.lastLow?.label).toBe("LL");
    expect(s.lastHigh?.label).toBe("LH");
    expect(s.trend).toBe("downtrend");
  });

  it("reads mixed swings (HH + LL) as range, not a trend", () => {
    const s = computeMarketStructure(pivots(["low", 10], ["high", 20], ["low", 8], ["high", 25]));

    expect(s.lastHigh?.label).toBe("HH");
    expect(s.lastLow?.label).toBe("LL");
    expect(s.trend).toBe("range");
  });

  it("leaves the first high and first low unlabeled", () => {
    const s = computeMarketStructure(pivots(["high", 20], ["low", 10]));

    expect(s.swings[0].label).toBeNull();
    expect(s.swings[1].label).toBeNull();
    expect(s.trend).toBe("range");
  });

  it("marks a break that extends the trend as BOS", () => {
    // Establish an uptrend, then print another higher high.
    const s = computeMarketStructure(
      pivots(["low", 10], ["high", 20], ["low", 12], ["high", 24], ["low", 15], ["high", 30]),
    );

    expect(s.event).toBe("bos");
    expect(s.eventSwing?.label).toBe("HH");
  });

  it("marks a break against the trend as CHoCH", () => {
    // Uptrend (HH + HL), then a low that undercuts the prior low → change of character.
    const s = computeMarketStructure(
      pivots(["low", 10], ["high", 20], ["low", 12], ["high", 24], ["low", 8]),
    );

    expect(s.event).toBe("choch");
    expect(s.eventSwing?.label).toBe("LL");
    // The break knocks structure out of the uptrend.
    expect(s.trend).not.toBe("uptrend");
  });

  it("returns an empty, neutral structure for no pivots", () => {
    const s = computeMarketStructure([]);

    expect(s.swings).toEqual([]);
    expect(s.trend).toBe("range");
    expect(s.lastHigh).toBeNull();
    expect(s.lastLow).toBeNull();
    expect(s.event).toBeNull();
  });

  // --- Tie-break: an equal level fails to extend the extreme ------------------

  it("labels an equal high as LH and an equal low as HL (strict break required)", () => {
    const equalHigh = computeMarketStructure(pivots(["high", 100], ["low", 50], ["high", 100]));
    expect(equalHigh.lastHigh?.label).toBe("LH");

    const equalLow = computeMarketStructure(pivots(["low", 100], ["high", 150], ["low", 100]));
    expect(equalLow.lastLow?.label).toBe("HL");
  });

  it("reads a flat range (equal highs and equal lows) as range, not downtrend", () => {
    // The edge the review flagged: strict-`>` on both sides would print LH+LL
    // and misclassify this as a downtrend.
    const s = computeMarketStructure(
      pivots(["high", 100], ["low", 90], ["high", 100], ["low", 90]),
    );

    expect(s.lastHigh?.label).toBe("LH");
    expect(s.lastLow?.label).toBe("HL");
    expect(s.trend).toBe("range");
    expect(s.event).toBeNull();
  });

  // --- Event emission: structure forming vs. breaking ------------------------

  it("emits no event for the first break that only forms a trend", () => {
    // The first HH establishes the uptrend from range — there is no prior trend
    // to break, so no BOS is reported until a real continuation happens.
    const s = computeMarketStructure(pivots(["low", 10], ["high", 20], ["low", 12], ["high", 24]));

    expect(s.trend).toBe("uptrend");
    expect(s.event).toBeNull();
    expect(s.swings.every((sw) => sw.event === null)).toBe(true);
  });

  it("emits no event for an only-highs or only-lows series", () => {
    const onlyHighs = computeMarketStructure(pivots(["high", 10], ["high", 20], ["high", 15]));
    expect(onlyHighs.lastLow).toBeNull();
    expect(onlyHighs.trend).toBe("range");
    expect(onlyHighs.event).toBeNull();

    const onlyLows = computeMarketStructure(pivots(["low", 20], ["low", 10], ["low", 15]));
    expect(onlyLows.lastHigh).toBeNull();
    expect(onlyLows.trend).toBe("range");
    expect(onlyLows.event).toBeNull();
  });

  it("retains each break on its own swing while exposing the latest as event", () => {
    // Uptrend forms (no event), continues with a BOS, then reverses with a CHoCH.
    const s = computeMarketStructure(
      pivots(
        ["low", 10],
        ["high", 20],
        ["low", 12],
        ["high", 24],
        ["low", 15],
        ["high", 30],
        ["low", 8],
      ),
    );

    const events = s.swings.map((sw) => sw.event);
    expect(events).toEqual([null, null, null, null, null, "bos", "choch"]);
    // The structure-level event/eventSwing surface only the latest break.
    expect(s.event).toBe("choch");
    expect(s.eventSwing?.event).toBe("choch");
    expect(s.eventSwing).toBe(s.swings[6]);
  });

  // --- Replay safety: a prefix reproduces the live prefix exactly ------------

  it("produces prefix-identical swings (replay equals live)", () => {
    const seq: [PivotPoint["kind"], number][] = [
      ["low", 10],
      ["high", 20],
      ["low", 12],
      ["high", 24],
      ["low", 15],
      ["high", 30],
      ["low", 8],
      ["high", 18],
    ];
    const full = computeMarketStructure(pivots(...seq));

    for (let k = 1; k <= seq.length; k++) {
      const prefix = computeMarketStructure(pivots(...seq.slice(0, k)));
      expect(prefix.swings).toEqual(full.swings.slice(0, k));
    }
  });
});
