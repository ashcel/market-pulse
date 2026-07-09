import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { generateMockCandles } from "./mock-candles";
import { computeMarketStructure, toAlternatingSwings } from "./structure";
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

  // --- Classification runs on alternating legs, not raw same-kind adjacency --

  it("does not fabricate a swing label from a lower pivot inside the same leg", () => {
    // high30 then high25 with no low between: 25 is inside the 30 leg, not a
    // lower-high swing. Raw same-kind comparison would label it LH; the model
    // must collapse the run and keep 30, so lastHigh stays HH.
    const s = computeMarketStructure(
      pivots(["high", 10], ["low", 5], ["high", 30], ["high", 25], ["low", 3]),
    );

    expect(s.swings.map((w) => [w.kind, w.price, w.label])).toEqual([
      ["high", 10, null],
      ["low", 5, null],
      ["high", 30, "HH"],
      ["low", 3, "LL"],
    ]);
    expect(s.lastHigh?.label).toBe("HH");
  });

  it("keeps swings strictly alternating for real confirmed pivots", () => {
    const s = computeMarketStructure(computePivots(generateMockCandles("DOGE", "1H", 500)));

    expect(s.swings.length).toBeGreaterThan(1);
    for (let i = 1; i < s.swings.length; i++) {
      expect(s.swings[i].kind).not.toBe(s.swings[i - 1].kind);
    }
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

describe("toAlternatingSwings", () => {
  it("collapses a run of highs to the highest and a run of lows to the lowest", () => {
    const legs = toAlternatingSwings(
      pivots(["low", 10], ["high", 20], ["high", 25], ["high", 22], ["low", 12]),
    );

    expect(legs.map((l) => [l.kind, l.price])).toEqual([
      ["low", 10],
      ["high", 25],
      ["low", 12],
    ]);
  });

  it("keeps the lowest of consecutive lows", () => {
    const legs = toAlternatingSwings(
      pivots(["high", 30], ["low", 20], ["low", 15], ["low", 18], ["high", 25]),
    );

    expect(legs.map((l) => [l.kind, l.price])).toEqual([
      ["high", 30],
      ["low", 15],
      ["high", 25],
    ]);
  });

  it("breaks ties toward the earlier pivot in a run", () => {
    // Two equal highs in one leg: keep the first-formed (time 2), drop time 3.
    const legs = toAlternatingSwings(pivots(["low", 10], ["high", 20], ["high", 20]));

    expect(legs).toHaveLength(2);
    expect(legs[1].time).toBe(2);
  });

  it("emits a strictly alternating sequence even from runs on both sides", () => {
    const legs = toAlternatingSwings(
      pivots(
        ["high", 5],
        ["high", 8],
        ["high", 6],
        ["low", 3],
        ["low", 1],
        ["high", 9],
        ["low", 2],
        ["low", 4],
      ),
    );

    for (let i = 1; i < legs.length; i++) {
      expect(legs[i].kind).not.toBe(legs[i - 1].kind);
    }
    expect(legs.map((l) => [l.kind, l.price])).toEqual([
      ["high", 8],
      ["low", 1],
      ["high", 9],
      ["low", 2],
    ]);
  });

  it("returns an empty sequence for no pivots", () => {
    expect(toAlternatingSwings([])).toEqual([]);
  });
});
