import { describe, expect, it } from "vitest";

import { computePivots, pivotWindow } from "./analysis";
import { generateMockCandles } from "./mock-candles";
import { computeMarketStructure } from "./structure";
import { deriveSwingStrength } from "./strength";
import type { PivotPoint } from "./types";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

function pivot(kind: "high" | "low", price: number, time: number): PivotPoint {
  return { kind, price, time };
}

function strengths(pivots: PivotPoint[]): string[] {
  return deriveSwingStrength(computeMarketStructure(pivots)).map((e) => e.strength);
}

describe("deriveSwingStrength", () => {
  it("returns one entry per swing, joined by identity, in order", () => {
    const structure = computeMarketStructure([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 105, 3),
      pivot("high", 120, 4),
    ]);
    const entries = deriveSwingStrength(structure);
    expect(entries).toHaveLength(structure.swings.length);
    for (const [i, entry] of entries.entries()) {
      expect(entry.swing).toBe(structure.swings[i]);
    }
  });

  it("marks a high strong the moment its pullback breaks the prior low, even mid-leg", () => {
    const structure = computeMarketStructure([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 90, 3), // still-forming counter-leg already below 100
    ]);
    const entries = deriveSwingStrength(structure);
    expect(entries[1].strength).toBe("strong");
    expect(entries[1].judgedBy).toBe(structure.swings[2]);
  });

  it("marks a high weak only once its failed counter-leg completes", () => {
    const forming = strengths([pivot("low", 100, 1), pivot("high", 110, 2), pivot("low", 105, 3)]);
    // Counter-leg holds above 100 but could still extend down: unresolved.
    expect(forming[1]).toBe("unresolved");

    const completed = strengths([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 105, 3),
      pivot("high", 108, 4), // next high freezes the leg at 105 — the push down failed
    ]);
    expect(completed[1]).toBe("weak");
  });

  it("reads an uptrend as weak highs over strong lows", () => {
    const entries = deriveSwingStrength(
      computeMarketStructure([
        pivot("low", 100, 1),
        pivot("high", 110, 2),
        pivot("low", 105, 3),
        pivot("high", 120, 4),
        pivot("low", 112, 5),
        pivot("high", 130, 6),
      ]),
    );
    // Consumed highs failed to break down; pullback lows launched the breaks up.
    expect(entries.map((e) => e.strength)).toEqual([
      "unresolved", // first swing: no prior opposite swing to measure against
      "weak",
      "strong",
      "weak",
      "strong",
      "unresolved", // last swing: no counter-leg yet
    ]);
  });

  it("reads a downtrend as strong highs over weak lows (mirror)", () => {
    const entries = strengths([
      pivot("high", 130, 1),
      pivot("low", 120, 2),
      pivot("high", 125, 3),
      pivot("low", 110, 4),
      pivot("high", 115, 5),
      pivot("low", 100, 6),
    ]);
    expect(entries).toEqual(["unresolved", "weak", "strong", "weak", "strong", "unresolved"]);
  });

  it("does not count an equal-level retest as a break", () => {
    // Counter-leg exactly matches the prior low: strict inequality ⇒ no break,
    // so completing the leg settles the high weak, not strong.
    const entries = strengths([
      pivot("low", 100, 1),
      pivot("high", 110, 2),
      pivot("low", 100, 3),
      pivot("high", 104, 4),
    ]);
    expect(entries[1]).toBe("weak");
  });

  it("never settles the last two swings weak (their legs cannot be complete)", () => {
    for (const symbol of ["BTC", "ETH", "SOL"]) {
      const candles = generateMockCandles(symbol, "1H", 300);
      const entries = deriveSwingStrength(computeMarketStructure(computePivots(candles)));
      for (const entry of entries.slice(-2)) {
        expect(entry.strength).not.toBe("weak");
      }
      const last = entries[entries.length - 1];
      expect(last.strength).toBe("unresolved");
      expect(last.judgedBy).toBeNull();
    }
  });

  it("is append-only under growing windows while the pivot substrate is stable", () => {
    // pivotWindow(n) = ceil(n/40) steps every 40 bars, reshuffling which
    // pivots exist at all (a pre-existing engine-wide property — EDR 0003's
    // "cross-window object permanence is not promised"). Within a span where
    // it is constant, a resolved strength must never change: a break cannot
    // un-happen and a completed failed leg cannot retroactively succeed.
    for (const symbol of ["BTC", "ETH", "SOL", "DOGE"]) {
      const candles = generateMockCandles(symbol, "1H", 480);
      let currentK = -1;
      let seen = new Map<string, string>();
      let resolutions = 0;
      for (let n = 60; n <= candles.length; n++) {
        const k = pivotWindow(n);
        if (k !== currentK) {
          currentK = k;
          seen = new Map();
        }
        const entries = deriveSwingStrength(
          computeMarketStructure(computePivots(candles.slice(0, n))),
        );
        for (const entry of entries) {
          const key = `${entry.swing.time}:${entry.swing.kind}`;
          const previous = seen.get(key);
          if (previous && previous !== "unresolved") {
            expect(`${key} ${previous}->${entry.strength}`).toBe(`${key} ${previous}->${previous}`);
          }
          if (entry.strength !== "unresolved") resolutions++;
          seen.set(key, entry.strength);
        }
      }
      expect(resolutions).toBeGreaterThan(100);
    }
  });
});

describe("dreimann annotation fidelity — strength", () => {
  // Logic correctness only: do we type the swings the trader drew the way the
  // trader read them? Never tune a threshold against these (R5).

  it.each(DREIMANN_TRADES)(
    "%s: a strong low protects below the entry on the 4h context as-of entry",
    (name) => {
      // Every example trade is a pullback long riding defended structure, so
      // the low that launched the HTF leg must read strong at decision time.
      const fixture = loadDreimannFixture(name);
      const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
      const context = fixture.series["4h"]!.filter((c) => c.time <= entryTime);
      const entries = deriveSwingStrength(computeMarketStructure(computePivots(context)));
      const protectedLows = entries.filter(
        (e) =>
          e.swing.kind === "low" &&
          e.strength === "strong" &&
          e.swing.price < fixture.labels.entry.price,
      );
      expect(protectedLows.length).toBeGreaterThan(0);
    },
  );

  const weakStructureTrades = DREIMANN_TRADES.filter(
    (name) => loadDreimannFixture(name).labels.objective.claimsWeakStructure,
  );

  it.each(weakStructureTrades)(
    "%s: the claimed weak-structure objective is targetable at entry and settles weak",
    (name) => {
      const fixture = loadDreimannFixture(name);
      const { labels } = fixture;
      const candles = fixture.series[labels.executionTimeframe]!;
      const entryTime = labelTime(labels.entry.approxTimeUtc);
      const tolerance = labels.objective.tolerancePct / 100;
      const matchesObjective = (price: number) =>
        Math.abs(price - labels.objective.price) / labels.objective.price <= tolerance;

      // As-of the entry bar: at least one pre-entry swing high at the
      // objective level must read weak or unresolved — targetable, not a
      // defended (strong) high. This is the read that licenses the trade.
      const atEntry = deriveSwingStrength(
        computeMarketStructure(computePivots(candles.filter((c) => c.time <= entryTime))),
      );
      const targetable = atEntry.filter(
        (e) =>
          e.swing.kind === "high" &&
          e.swing.time < entryTime &&
          matchesObjective(e.swing.price) &&
          e.strength !== "strong",
      );
      expect(targetable.length).toBeGreaterThan(0);

      // On the full window: at least one objective-level high that price
      // actually took out afterwards settles weak — 'objective hit weak
      // structure', reproduced.
      const maxAfterEntry = Math.max(
        ...candles.filter((c) => c.time > entryTime).map((c) => c.high),
      );
      const full = deriveSwingStrength(computeMarketStructure(computePivots(candles)));
      const settledWeak = full.filter(
        (e) =>
          e.swing.kind === "high" &&
          e.swing.time < entryTime &&
          matchesObjective(e.swing.price) &&
          e.swing.price <= maxAfterEntry &&
          e.strength === "weak",
      );
      expect(settledWeak.length).toBeGreaterThan(0);
    },
  );

  it("zec-sl: the dotted H4 objective is the Jul 4 swing high — unresolved at entry, weak once its leg completes", () => {
    // The sharpest single annotation in the set: the chart's dotted
    // weak-structure line at ~476.9 is one specific 4h swing.
    const fixture = loadDreimannFixture("zec-sl");
    const candles = fixture.series["4h"]!;
    const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);

    const atEntry = deriveSwingStrength(
      computeMarketStructure(computePivots(candles.filter((c) => c.time <= entryTime))),
    );
    const objectiveAtEntry = atEntry.find(
      (e) => e.swing.kind === "high" && Math.abs(e.swing.price - 476.74) < 0.01,
    );
    expect(objectiveAtEntry?.strength).toBe("unresolved");

    const full = deriveSwingStrength(computeMarketStructure(computePivots(candles)));
    const objectiveFull = full.find(
      (e) => e.swing.kind === "high" && Math.abs(e.swing.price - 476.74) < 0.01,
    );
    expect(objectiveFull?.strength).toBe("weak");
  });
});
