import { describe, expect, it } from "vitest";

import { generateMockCandles } from "./mock-candles";
import { computeBaseZones } from "./zones";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

/**
 * Characterization of `computeBaseZones` — pins today's exact output so the
 * planned candidate-extraction refactor (POI lifecycle work) is provably
 * byte-identical. These are not aspirational assertions: if a legitimate
 * behavior change is ever intended, it must bump ENGINE_VERSION and these
 * pins get re-recorded deliberately, never regenerated in passing.
 */

function dreimannContext(name: (typeof DREIMANN_TRADES)[number]) {
  const fixture = loadDreimannFixture(name);
  const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
  return fixture.series["4h"]!.filter((c) => c.time <= entryTime);
}

describe("computeBaseZones characterization", () => {
  it("finds no bases on smooth synthetic tape — the conviction gate holds", () => {
    // Mock candles never produce a departure body ≥ 1.15×ATR with ≥ 55% body
    // share; pinning the empty result guards the gate's calibration.
    for (const symbol of ["BTC", "ETH", "SOL"]) {
      for (const tf of ["1H", "4H", "1D"] as const) {
        expect(computeBaseZones(generateMockCandles(symbol, tf, 360))).toEqual([]);
      }
    }
  });

  it("pins the exact zec-sl 4h zones as-of entry — the EDR 0009 reference read", () => {
    expect(computeBaseZones(dreimannContext("zec-sl"))).toEqual([
      {
        kind: "demand",
        priceLow: 418.2,
        priceHigh: 425.92,
        startTime: 1782964800,
        endTime: 1782979200,
        freshness: "tested",
      },
      {
        kind: "supply",
        priceLow: 455.5765714285714,
        priceHigh: 457.44,
        startTime: 1783310400,
        endTime: 1783324800,
        freshness: "tested",
      },
    ]);
  });

  it.each([
    [
      "zec-tp",
      [{ kind: "demand", priceLow: 418.2, priceHigh: 425.92, freshness: "tested" }],
    ] as const,
    [
      "trx-tp3",
      [{ kind: "demand", priceLow: 0.31996, priceHigh: 0.32108, freshness: "fresh" }],
    ] as const,
    [
      "ethfi-sl",
      [{ kind: "demand", priceLow: 0.3169, priceHigh: 0.3197, freshness: "fresh" }],
    ] as const,
    ["jup-tp", []] as const,
    [
      "fet-tp",
      [{ kind: "supply", priceLow: 0.1884, priceHigh: 0.1896, freshness: "tested" }],
    ] as const,
  ])("pins the %s 4h zone set as-of entry", (name, expected) => {
    const zones = computeBaseZones(dreimannContext(name));
    expect(zones).toHaveLength(expected.length);
    expected.forEach((pin, i) => expect(zones[i]).toMatchObject(pin));
  });

  it.each(DREIMANN_TRADES)("%s: structural invariants hold over every prefix window", (name) => {
    const context = dreimannContext(name);
    for (let n = 30; n <= context.length; n += 25) {
      const zones = computeBaseZones(context.slice(0, n));
      // Determinism.
      expect(computeBaseZones(context.slice(0, n))).toEqual(zones);
      // At most 2 per kind, chronological, well-formed bounds, valid freshness.
      expect(zones.filter((z) => z.kind === "demand").length).toBeLessThanOrEqual(2);
      expect(zones.filter((z) => z.kind === "supply").length).toBeLessThanOrEqual(2);
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        expect(z.priceLow).toBeLessThan(z.priceHigh);
        expect(z.startTime).toBeLessThanOrEqual(z.endTime);
        expect(["fresh", "tested"]).toContain(z.freshness);
        if (i > 0) expect(z.startTime).toBeGreaterThanOrEqual(zones[i - 1].startTime);
        // No same-kind overlap survives selection.
        for (let j = i + 1; j < zones.length; j++) {
          const other = zones[j];
          if (other.kind !== z.kind) continue;
          expect(z.priceLow > other.priceHigh || z.priceHigh < other.priceLow).toBe(true);
        }
      }
    }
  });
});
