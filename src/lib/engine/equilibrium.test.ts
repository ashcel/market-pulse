import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { classifyPrice, computeDealingRange } from "./equilibrium";
import { computeMarketStructure } from "./structure";
import { deriveSwingStrength } from "./strength";
import type { PivotPoint } from "./types";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

function pivot(kind: "high" | "low", price: number, time: number): PivotPoint {
  return { kind, price, time };
}

describe("computeDealingRange", () => {
  it("returns null while no swing has proven strong", () => {
    const structure = computeMarketStructure([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 105, 3),
    ]);
    expect(computeDealingRange(structure)).toBeNull();
  });

  it("anchors at the most recent strong low and spans to the extreme high after it", () => {
    // Uptrend: strong lows at 105 and 112; the later one anchors the range.
    const structure = computeMarketStructure([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 105, 3),
      pivot("high", 120, 4),
      pivot("low", 112, 5),
      pivot("high", 130, 6),
    ]);
    const range = computeDealingRange(structure);
    expect(range).not.toBeNull();
    expect(range!.anchor).toBe("low");
    expect(range!.low.price).toBe(112);
    expect(range!.high.price).toBe(130);
    expect(range!.equilibrium).toBe(121);
  });

  it("anchors at the most recent strong high in a downtrend (mirror)", () => {
    const structure = computeMarketStructure([
      pivot("high", 130, 1),
      pivot("low", 120, 2),
      pivot("high", 125, 3),
      pivot("low", 110, 4),
      pivot("high", 115, 5),
      pivot("low", 100, 6),
    ]);
    const range = computeDealingRange(structure);
    expect(range).not.toBeNull();
    expect(range!.anchor).toBe("high");
    expect(range!.high.price).toBe(115);
    expect(range!.low.price).toBe(100);
    expect(range!.equilibrium).toBe(107.5);
  });

  it("spans to the most extreme opposite swing, not merely the nearest", () => {
    // After the strong low at 105, highs print at 120 then 118: the range
    // ceiling is the extreme (120), not the latest.
    const structure = computeMarketStructure([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 105, 3),
      pivot("high", 120, 4),
      pivot("low", 111, 5),
      pivot("high", 118, 6),
    ]);
    const range = computeDealingRange(structure);
    expect(range).not.toBeNull();
    expect(range!.low.price).toBe(105);
    expect(range!.high.price).toBe(120);
  });

  it("stays coherent with the strength view it is derived from", () => {
    for (const name of DREIMANN_TRADES) {
      const fixture = loadDreimannFixture(name);
      for (const candles of Object.values(fixture.series)) {
        const structure = computeMarketStructure(computePivots(candles));
        const range = computeDealingRange(structure);
        if (!range) continue;
        expect(range.low.price).toBeLessThan(range.high.price);
        expect(range.equilibrium).toBe((range.low.price + range.high.price) / 2);
        const anchorSwing = range.anchor === "low" ? range.low : range.high;
        const entry = deriveSwingStrength(structure).find((e) => e.swing === anchorSwing);
        expect(entry?.strength).toBe("strong");
      }
    }
  });
});

describe("classifyPrice", () => {
  it("splits the range at its exact midpoint", () => {
    const structure = computeMarketStructure([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 105, 3),
      pivot("high", 120, 4),
      pivot("low", 112, 5),
      pivot("high", 130, 6),
    ]);
    const range = computeDealingRange(structure)!;
    expect(classifyPrice(range, 125)).toBe("premium");
    expect(classifyPrice(range, 118)).toBe("discount");
    expect(classifyPrice(range, 121)).toBe("equilibrium");
  });
});

describe("dreimann annotation fidelity — equilibrium", () => {
  // Logic correctness only; no threshold tuning against these fixtures (R5).

  it.each(DREIMANN_TRADES)("%s: an active 4h dealing range exists as-of entry", (name) => {
    const fixture = loadDreimannFixture(name);
    const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
    const context = fixture.series["4h"]!.filter((c) => c.time <= entryTime);
    const range = computeDealingRange(computeMarketStructure(computePivots(context)));
    expect(range).not.toBeNull();
  });

  const canonical = DREIMANN_TRADES.filter(
    (name) => loadDreimannFixture(name).labels.objective.claimsWeakStructure,
  );

  it.each(canonical)(
    "%s: the canonical weak-structure setup was bought at a discount of the 4h range",
    (name) => {
      // The two A-book examples ('objective hit weak structure') are the
      // trades where the full framework read applies — including the "long
      // only in discount" gate.
      const fixture = loadDreimannFixture(name);
      const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
      const context = fixture.series["4h"]!.filter((c) => c.time <= entryTime);
      const range = computeDealingRange(computeMarketStructure(computePivots(context)))!;
      expect(classifyPrice(range, fixture.labels.entry.price)).toBe("discount");
    },
  );

  it("jup-tp: the premium read reproduces the trader's own risk note", () => {
    // trades.txt: "Risky because bullish BOS on H4 may already have completed
    // and pullback could happen" — i.e. the entry chased an extended leg.
    // The equilibrium read says the same thing: entry above the midpoint.
    const fixture = loadDreimannFixture("jup-tp");
    const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
    const context = fixture.series["4h"]!.filter((c) => c.time <= entryTime);
    const range = computeDealingRange(computeMarketStructure(computePivots(context)))!;
    expect(classifyPrice(range, fixture.labels.entry.price)).toBe("premium");
  });

  it("characterizes the observed entry positions across all six trades", () => {
    // Regression pin of today's derivation, not ground truth: only trx-tp3 /
    // zec-sl (discount, claim-backed) and jup-tp (premium, matching the risk
    // note) correspond to trader statements. zec-tp/ethfi-sl discount and
    // fet-tp premium are observed reads the source material neither confirms
    // nor denies.
    const positions = Object.fromEntries(
      DREIMANN_TRADES.map((name) => {
        const fixture = loadDreimannFixture(name);
        const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
        const context = fixture.series["4h"]!.filter((c) => c.time <= entryTime);
        const range = computeDealingRange(computeMarketStructure(computePivots(context)))!;
        return [name, classifyPrice(range, fixture.labels.entry.price)];
      }),
    );
    expect(positions).toEqual({
      "zec-tp": "discount",
      "trx-tp3": "discount",
      "zec-sl": "discount",
      "ethfi-sl": "discount",
      "jup-tp": "premium",
      "fet-tp": "premium",
    });
  });
});
