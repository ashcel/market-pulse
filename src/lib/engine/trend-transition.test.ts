import { describe, expect, it } from "vitest";

import { computePivots } from "./analysis";
import { generateMockCandles } from "./mock-candles";
import { computeMarketStructure } from "./structure";
import { deriveTrendTransitions, latestTransition } from "./trend-transition";
import type { PivotPoint } from "./types";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

function pivot(kind: "high" | "low", price: number, time: number): PivotPoint {
  return { kind, price, time };
}

/** Downtrend: LH 90 / LL 40 after the opening 100/50 pair. */
const DOWNTREND: PivotPoint[] = [
  pivot("high", 100, 1),
  pivot("low", 50, 2),
  pivot("high", 90, 3),
  pivot("low", 40, 4),
];

describe("deriveTrendTransitions", () => {
  it("emits a choch-hint when structure breaks against the trend, then confirms on the flip", () => {
    // Downtrend → HH CHoCH at 110 → HL at 60 completes uptrend labels.
    const structure = computeMarketStructure([
      ...DOWNTREND,
      pivot("high", 110, 5),
      pivot("low", 60, 6),
    ]);
    const transitions = deriveTrendTransitions(structure);
    // [0] is the opening range→downtrend formation the fixture itself prints.
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ from: "range", to: "downtrend", phase: "confirmed" });
    expect(transitions[1]).toMatchObject({
      from: "downtrend",
      to: "uptrend",
      phase: "confirmed",
      time: 6,
    });
    expect(transitions[1].chochSwing?.time).toBe(5);
    expect(transitions[1].confirmSwing?.time).toBe(6);
    expect(structure.trend).toBe("uptrend");
  });

  it("holds the hint through the range interlude — a live hint is the latest transition", () => {
    // The CHoCH alone: labels HH beside the stale LL read as range, but the
    // hint must survive that interlude awaiting its confirming swing.
    const structure = computeMarketStructure([...DOWNTREND, pivot("high", 110, 5)]);
    const latest = latestTransition(structure);
    expect(latest).toMatchObject({
      from: "downtrend",
      to: "uptrend",
      phase: "choch-hint",
      confirmSwing: null,
      time: 5,
    });
  });

  it("keeps a failed hint in history, unconfirmed, when the market resumes instead", () => {
    // CHoCH HH at 110, then a new LL at 30 — the reversal died.
    const structure = computeMarketStructure([
      ...DOWNTREND,
      pivot("high", 110, 5),
      pivot("low", 30, 6),
    ]);
    const transitions = deriveTrendTransitions(structure);
    expect(transitions).toHaveLength(2); // [0] = the opening range→downtrend formation
    expect(transitions[1]).toMatchObject({ phase: "choch-hint", confirmSwing: null });
    // A later HL that would have confirmed the dead hint no longer counts:
    // labels after LL(30) then HL(35)... HH(110)+HL reads uptrend, but the
    // transition record is a fresh one, not the dead hint upgraded.
    const resumed = computeMarketStructure([
      ...DOWNTREND,
      pivot("high", 110, 5),
      pivot("low", 30, 6),
      pivot("high", 105, 7),
      pivot("low", 35, 8),
    ]);
    const later = deriveTrendTransitions(resumed);
    const confirmedLater = later.filter((t) => t.phase === "confirmed");
    for (const t of confirmedLater) {
      expect(t.chochSwing?.time ?? null).not.toBe(5);
    }
  });

  it("records structure forming straight out of a range with a null chochSwing", () => {
    const structure = computeMarketStructure([
      pivot("high", 100, 1),
      pivot("low", 50, 2),
      pivot("high", 110, 3), // HH in range: forming, no event
      pivot("low", 60, 4), // HL → uptrend
    ]);
    const transitions = deriveTrendTransitions(structure);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      from: "range",
      to: "uptrend",
      phase: "confirmed",
      chochSwing: null,
      time: 4,
    });
  });

  it("parity: the fold's final trend always equals structure.trend", () => {
    const windows = [
      ...["BTC", "ETH", "SOL"].map((s) => generateMockCandles(s, "4H", 360)),
      ...DREIMANN_TRADES.map((name) => {
        const fixture = loadDreimannFixture(name);
        const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
        return fixture.series["4h"]!.filter((c) => c.time <= entryTime);
      }),
    ];
    for (const candles of windows) {
      for (let n = 60; n <= candles.length; n += 50) {
        const structure = computeMarketStructure(computePivots(candles.slice(0, n)));
        const transitions = deriveTrendTransitions(structure);
        const confirmed = transitions.filter((t) => t.phase === "confirmed");
        // The last confirmed transition's destination is the current trend,
        // unless the market has since fallen back into range.
        const last = confirmed.at(-1);
        if (structure.trend !== "range") {
          expect(last?.to).toBe(structure.trend);
        }
        // Structural coherence of every record.
        for (const t of transitions) {
          expect(t.from).not.toBe(t.to);
          if (t.phase === "confirmed") {
            expect(t.confirmSwing).not.toBeNull();
            expect(t.time).toBe(t.confirmSwing!.time);
          } else {
            expect(t.confirmSwing).toBeNull();
            expect(t.chochSwing).not.toBeNull();
          }
          if (t.chochSwing && t.confirmSwing) {
            expect(t.chochSwing.time).toBeLessThanOrEqual(t.confirmSwing.time);
          }
        }
      }
    }
  });

  it("is deterministic and prefix-safe over the swing sequence: a confirmed record never changes", () => {
    // The fold is forward-only over structure.swings, so its guarantee is
    // stated on swing prefixes (candle-window prefixes reshuffle the pivots
    // themselves — computePivots adapts its window to the series length).
    const candles = loadDreimannFixture("zec-sl").series["4h"]!;
    const structure = computeMarketStructure(computePivots(candles));
    const full = deriveTrendTransitions(structure);
    expect(deriveTrendTransitions(structure)).toEqual(full);
    const key = (t: ReturnType<typeof deriveTrendTransitions>[number]) =>
      `${t.from}>${t.to}@${t.time}`;
    const confirmedFull = new Set(full.filter((t) => t.phase === "confirmed").map(key));
    for (let m = 1; m <= structure.swings.length; m++) {
      const sub = deriveTrendTransitions({ ...structure, swings: structure.swings.slice(0, m) });
      for (const t of sub.filter((x) => x.phase === "confirmed")) {
        // Confirmed at swing ≤ m ⇒ the full history holds it identically
        // (only live hints may still upgrade after the prefix ends).
        expect(confirmedFull.has(key(t))).toBe(true);
      }
    }
  });
});
