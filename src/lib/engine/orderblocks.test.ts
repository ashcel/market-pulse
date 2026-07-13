import { describe, expect, it } from "vitest";

import { detectOrderBlocks, selectOrderBlocks, type OrderBlock } from "./orderblocks";
import type { Candle } from "./types";
import { DREIMANN_TRADES, labelTime, loadDreimannFixture } from "./__fixtures__/dreimann";

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 1_000 };
}

/** A flat run of unit-range candles so ATR14 settles near 1. */
function flatRun(count: number, price = 100, startTime = 0): Candle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(startTime + i, price, price + 0.5, price - 0.5, price),
  );
}

const base = flatRun(30);
const t = base.length; // next free bar time

describe("detectOrderBlocks", () => {
  it("finds the last down candle before an up displacement as a demand OB", () => {
    const blocks = detectOrderBlocks([
      ...base,
      candle(t, 100.3, 100.5, 99.6, 99.7), // opposing (down) candle — the OB
      candle(t + 1, 99.7, 101.3, 99.6, 101.2), // displacement: body 1.5 ≥ 1.15×ATR, 88% of range
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "demand",
      priceLow: 99.6,
      priceHigh: 100.5,
      time: t,
      displacementTime: t + 1,
      sweptSwing: false,
    });
    expect(blocks[0].displacementAtr).toBeGreaterThanOrEqual(1.15);
  });

  it("mirrors for supply: last up candle before a down displacement", () => {
    const blocks = detectOrderBlocks([
      ...base,
      candle(t, 99.7, 100.4, 99.5, 100.3), // opposing (up) candle
      candle(t + 1, 100.3, 100.4, 98.7, 98.8), // bearish displacement
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "supply", time: t, priceHigh: 100.4 });
  });

  it("requires displacement conviction — body vs ATR and body share of range", () => {
    // Body 0.8 < 1.15×ATR: no OB.
    const weak = detectOrderBlocks([
      ...base,
      candle(t, 100.3, 100.5, 99.6, 99.7),
      candle(t + 1, 99.7, 100.6, 99.6, 100.5),
    ]);
    expect(weak).toHaveLength(0);
    // Body 1.5 but range 3.5 (43% share): mostly wick, no OB.
    const wicky = detectOrderBlocks([
      ...base,
      candle(t, 100.3, 100.5, 99.6, 99.7),
      candle(t + 1, 99.7, 103.1, 99.6, 101.2),
    ]);
    expect(wicky).toHaveLength(0);
  });

  it("walks back over indecision dojis to the opposing candle", () => {
    const blocks = detectOrderBlocks([
      ...base,
      candle(t, 100.3, 100.5, 99.6, 99.7), // the OB, two dojis later
      candle(t + 1, 99.7, 100.1, 99.5, 99.9), // doji (body 0.2, up-close — skippable)
      candle(t + 2, 99.9, 100.3, 99.7, 100.1), // doji
      candle(t + 3, 100.1, 101.7, 100.0, 101.6), // displacement
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].time).toBe(t);
  });

  it("aborts when a same-direction conviction candle precedes the displacement — continuation, not an OB", () => {
    const blocks = detectOrderBlocks([
      ...base,
      candle(t, 100.3, 100.5, 99.6, 99.7), // a down candle exists further back…
      candle(t + 1, 99.7, 100.6, 99.6, 100.4), // …but this up-close body (0.7 > 0.45×ATR) means the leg was already running
      candle(t + 2, 100.4, 102.0, 100.3, 101.9), // displacement
    ]);
    expect(blocks).toHaveLength(0);
  });

  it("flags a sweep-origin OB when its wick takes the prior lookback extreme", () => {
    const blocks = detectOrderBlocks([
      ...base, // prior lows all 99.5
      candle(t, 100.3, 100.5, 99.2, 99.7), // OB wick to 99.2 — below every prior low
      candle(t + 1, 99.7, 101.3, 99.6, 101.2),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sweptSwing).toBe(true);
  });

  it("is deterministic and prefix-replay-safe on real fixture data", () => {
    for (const name of ["zec-sl", "fet-tp"] as const) {
      const series = loadDreimannFixture(name).series["4h"]!;
      const full = detectOrderBlocks(series);
      expect(detectOrderBlocks(series)).toEqual(full);
      for (let n = 30; n <= series.length; n += 25) {
        const window = series.slice(0, n);
        const cutoff = window[window.length - 1].time;
        expect(detectOrderBlocks(window)).toEqual(full.filter((b) => b.displacementTime <= cutoff));
      }
    }
  });
});

describe("selectOrderBlocks", () => {
  const block = (
    kind: OrderBlock["kind"],
    priceLow: number,
    priceHigh: number,
    displacementTime: number,
    displacementAtr = 1.5,
  ): OrderBlock => ({
    kind,
    priceLow,
    priceHigh,
    time: displacementTime - 1,
    displacementTime,
    displacementAtr,
    sweptSwing: false,
  });

  it("ranks most recent first (preferred = [0]), caps at 2 per kind, drops same-kind overlap", () => {
    const picked = selectOrderBlocks([
      block("demand", 10, 11, 1),
      block("demand", 20, 21, 2),
      block("demand", 30, 31, 3),
      block("demand", 30.5, 32, 4), // overlaps the previous — newer wins
      block("supply", 50, 51, 5),
    ]);
    expect(picked[0].displacementTime).toBe(5);
    const demands = picked.filter((b) => b.kind === "demand");
    expect(demands).toHaveLength(2);
    expect(demands.map((b) => b.displacementTime)).toEqual([4, 2]); // 3 lost to overlap, 1 to the cap
  });
});

describe("dreimann annotation fidelity — recorded, not asserted", () => {
  it.each(DREIMANN_TRADES)("%s: OB reads as-of entry are structurally coherent", (name) => {
    const fixture = loadDreimannFixture(name);
    const entryTime = labelTime(fixture.labels.entry.approxTimeUtc);
    const context = fixture.series["4h"]!.filter((c) => c.time <= entryTime);
    const blocks = detectOrderBlocks(context);
    // Availability per fixture is a finding recorded in EDR 0013; here only
    // structure is asserted so a data refresh can't silently flip a verdict.
    for (const b of blocks) {
      expect(b.priceLow).toBeLessThan(b.priceHigh);
      expect(b.time).toBeLessThan(b.displacementTime);
      expect(b.displacementAtr).toBeGreaterThanOrEqual(1.15);
    }
  });
});
