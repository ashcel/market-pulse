import { describe, expect, it } from "vitest";

import { generateMockCandles } from "./mock-candles";
import { derivePoiLifecycle, MITIGATED_PENETRATION } from "./poi-lifecycle";
import type { Candle } from "./types";
import { computeBaseZoneCandidates, computeBaseZones } from "./zones";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

/** Bars for a demand band [100, 102] formed at time 5; formation linger, then price above. */
function bar(time: number, low: number, high: number, close: number): Candle {
  return { time, open: close, high, low, close, volume: 1 };
}

const BAND = { kind: "demand" as const, low: 100, high: 102 };
const away = (time: number) => bar(time, 105, 107, 106); // clear of the band

function derive(candles: Candle[], source: "base-zone" | "fvg" = "base-zone") {
  return derivePoiLifecycle(candles, 5, BAND.kind, BAND.low, BAND.high, source);
}

describe("derivePoiLifecycle — the state table", () => {
  it("fresh: never revisited after leaving", () => {
    const read = derive([away(6), away(7)]);
    expect(read).toMatchObject({ state: "fresh", touches: 0, decidedAt: null, inverted: false });
  });

  it("the initial linger neither counts as a touch nor as penetration", () => {
    // Price still inside the band right after formation, then leaves.
    const read = derive([bar(6, 101, 103, 102.5), away(7), away(8)]);
    expect(read.state).toBe("fresh");
    expect(read.touches).toBe(0);
  });

  it("tested: one shallow revisit, held", () => {
    const read = derive([away(6), bar(7, 101.5, 106, 105)]); // wick to 101.5 = 25% of the band
    expect(read).toMatchObject({ state: "tested", touches: 1, decidedAt: null });
  });

  it("mitigated: one revisit penetrating at least half the band", () => {
    const read = derive([away(6), bar(7, 100.9, 106, 105)]); // wick to 100.9 = 55%
    expect(read.state).toBe("mitigated");
    expect(read.touches).toBe(1);
    // The boundary itself mitigates (>=, not >).
    const edge = derive([away(6), bar(7, BAND.high - MITIGATED_PENETRATION * 2, 106, 105)]);
    expect(edge.state).toBe("mitigated");
  });

  it("invalidated: a close through the distal edge, decided at that bar and frozen", () => {
    const read = derive([away(6), bar(7, 98, 106, 99)]);
    expect(read).toMatchObject({ state: "invalidated", decidedAt: 7 });
    // Bars after the decision change nothing (first-touch-decides).
    const longer = derive([away(6), bar(7, 98, 106, 99), bar(8, 101, 103, 102)]);
    expect(longer).toEqual(read);
  });

  it("consumed: the second distinct revisit, decided at that bar", () => {
    const read = derive([away(6), bar(7, 101.5, 106, 105), away(8), bar(9, 101.5, 106, 105)]);
    expect(read).toMatchObject({ state: "consumed", touches: 2, decidedAt: 9 });
  });

  it("FVG sources carry filledFraction and invert on close-through; others carry null", () => {
    const zoneRead = derive([away(6), bar(7, 100.9, 106, 105)]);
    expect(zoneRead.filledFraction).toBeNull();
    const fvgRead = derive([away(6), bar(7, 100.9, 106, 105)], "fvg");
    expect(fvgRead.filledFraction).toBeCloseTo(0.55, 6);
    expect(fvgRead.inverted).toBe(false);
    const invertedRead = derive([away(6), bar(7, 98, 106, 99)], "fvg");
    expect(invertedRead).toMatchObject({ inverted: true, filledFraction: 1, decidedAt: 7 });
    // A zone trading through is invalidated but never "inverts".
    expect(derive([away(6), bar(7, 98, 106, 99)]).inverted).toBe(false);
  });
});

describe("derivePoiLifecycle — parity with zoneFreshness (EDR 0015)", () => {
  it("collapsing mitigated→tested and terminal→dropped reproduces computeBaseZones' freshness", () => {
    const windows = [
      ...DREIMANN_TRADES.map((name) => {
        const fixture = loadDreimannFixture(name);
        const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
        return fixture.series["4h"]!.filter((c) => c.time <= entryTime);
      }),
      generateMockCandles("BTC", "4H", 360),
    ];
    for (const candles of windows) {
      const surviving = new Map(
        computeBaseZones(candles).map((z) => [`${z.kind}:${z.startTime}`, z.freshness]),
      );
      for (const candidate of computeBaseZoneCandidates(candles)) {
        const read = derivePoiLifecycle(
          candles,
          candidate.endTime,
          candidate.kind,
          candidate.priceLow,
          candidate.priceHigh,
          "base-zone",
        );
        const freshness = surviving.get(`${candidate.kind}:${candidate.startTime}`);
        if (read.state === "invalidated" || read.state === "consumed") {
          // Terminal ⇔ zoneFreshness dropped it (never among survivors).
          expect(freshness).toBeUndefined();
        } else if (freshness !== undefined) {
          // Live and selected: fresh ⇔ fresh; tested|mitigated ⇔ tested.
          expect(read.state === "fresh" ? "fresh" : "tested").toBe(freshness);
        }
      }
    }
  });

  it("is prefix-replay-safe: a decided terminal state is identical for every longer window", () => {
    const candles = loadDreimannFixture("zec-sl").series["4h"]!;
    for (const candidate of computeBaseZoneCandidates(candles)) {
      const full = derivePoiLifecycle(
        candles,
        candidate.endTime,
        candidate.kind,
        candidate.priceLow,
        candidate.priceHigh,
        "base-zone",
      );
      if (full.decidedAt === null) continue;
      const decidedIndex = candles.findIndex((c) => c.time === full.decidedAt);
      for (let n = decidedIndex + 1; n <= candles.length; n += 20) {
        expect(
          derivePoiLifecycle(
            candles.slice(0, n),
            candidate.endTime,
            candidate.kind,
            candidate.priceLow,
            candidate.priceHigh,
            "base-zone",
          ),
        ).toEqual(full);
      }
    }
  });
});
