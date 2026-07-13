import { describe, expect, it } from "vitest";

import { detectFvgs, MIN_FVG_SIZE_ATR, selectFvgs, type Fvg } from "./fvg";
import { generateMockCandles } from "./mock-candles";
import type { Candle } from "./types";
import { atrSeries } from "./zones";

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 1_000 };
}

/** A flat run of unit-range candles so ATR14 settles near `range`. */
function flatRun(count: number, price: number, range = 1, startTime = 0): Candle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(startTime + i, price, price + range / 2, price - range / 2, price),
  );
}

describe("detectFvgs", () => {
  it("finds a bullish 3-candle imbalance: low[i] > high[i-2], gap [high[i-2], low[i]]", () => {
    const fvgs = detectFvgs([
      candle(1, 99, 100, 98, 99.5),
      candle(2, 99.5, 106, 99, 105.5),
      candle(3, 105.5, 107, 104, 106),
    ]);
    expect(fvgs).toHaveLength(1);
    expect(fvgs[0]).toMatchObject({
      kind: "bullish",
      gapLow: 100,
      gapHigh: 104,
      time: 2,
      confirmTime: 3,
      sizeAtr: null, // no ATR14 this early — recorded honestly, not guessed
    });
    expect(fvgs[0].sizePct).toBeCloseTo((4 / 102) * 100, 6);
  });

  it("mirrors for bearish: high[i] < low[i-2]", () => {
    const fvgs = detectFvgs([
      candle(1, 101, 102, 100, 100.5),
      candle(2, 100.5, 101, 94, 94.5),
      candle(3, 94.5, 96, 93, 95),
    ]);
    expect(fvgs).toHaveLength(1);
    expect(fvgs[0]).toMatchObject({ kind: "bearish", gapLow: 96, gapHigh: 100, time: 2 });
  });

  it("emits nothing when the third candle only touches the first — no imbalance", () => {
    const touching = detectFvgs([
      candle(1, 99, 100, 98, 99.5),
      candle(2, 99.5, 106, 99, 105.5),
      candle(3, 105.5, 107, 100, 106), // low === high[i-2]
    ]);
    expect(touching).toHaveLength(0);
  });

  it("applies the G7 size floor once ATR is measurable", () => {
    const run = flatRun(20, 100); // ATR14 ≈ 1
    const last = run[run.length - 1];
    // Tiny gap ≈ 0.1×ATR — below MIN_FVG_SIZE_ATR, dropped.
    const tiny = [
      ...run,
      candle(last.time + 1, 100, 101.2, 100.1, 101.1),
      candle(last.time + 2, 101.1, 101.4, 100.6, 101.2),
    ];
    expect(detectFvgs(tiny).filter((f) => f.confirmTime > last.time)).toHaveLength(0);

    // Wide gap ≈ 2×ATR — kept, with the normalized size recorded.
    const wide = [
      ...run,
      candle(last.time + 1, 100, 105, 100.2, 104.8),
      candle(last.time + 2, 104.8, 105.5, 102.5, 105),
    ];
    const found = detectFvgs(wide).filter((f) => f.confirmTime > last.time);
    expect(found).toHaveLength(1);
    expect(found[0].sizeAtr).not.toBeNull();
    expect(found[0].sizeAtr!).toBeGreaterThanOrEqual(MIN_FVG_SIZE_ATR);
    // The yardstick predates the displacement: gap / ATR-as-of-the-shelf.
    const atr = atrSeries(wide);
    expect(found[0].sizeAtr).toBeCloseTo((102.5 - 100.5) / atr[wide.length - 3]!, 6);
  });

  it("is deterministic and prefix-replay-safe: a confirmed gap never changes as the window grows", () => {
    for (const symbol of ["BTC", "ETH", "SOL"]) {
      const candles = generateMockCandles(symbol, "4H", 360);
      const full = detectFvgs(candles);
      expect(detectFvgs(candles)).toEqual(full);
      for (let n = 30; n <= candles.length; n += 30) {
        const window = candles.slice(0, n);
        const cutoff = window[window.length - 1].time;
        expect(detectFvgs(window)).toEqual(full.filter((f) => f.confirmTime <= cutoff));
      }
    }
  });
});

describe("selectFvgs", () => {
  const fvg = (kind: Fvg["kind"], gapLow: number, gapHigh: number, confirmTime: number): Fvg => ({
    kind,
    gapLow,
    gapHigh,
    time: confirmTime - 1,
    confirmTime,
    sizeAtr: 1,
    sizePct: 1,
  });

  it("ranks most recent first (preferred = [0]) and caps per kind", () => {
    const picked = selectFvgs([
      fvg("bullish", 10, 11, 1),
      fvg("bullish", 20, 21, 2),
      fvg("bullish", 30, 31, 3),
      fvg("bullish", 40, 41, 4),
      fvg("bearish", 50, 51, 5),
    ]);
    expect(picked[0].confirmTime).toBe(5);
    expect(picked.filter((f) => f.kind === "bullish")).toHaveLength(3);
    expect(picked.some((f) => f.confirmTime === 1)).toBe(false); // oldest bullish overflow dropped
  });

  it("drops overlapping same-kind duplicates, keeping the most recent", () => {
    const picked = selectFvgs([fvg("bullish", 10, 12, 1), fvg("bullish", 11, 13, 2)]);
    expect(picked).toHaveLength(1);
    expect(picked[0].confirmTime).toBe(2);
    // Opposite kinds may overlap — both kept.
    expect(selectFvgs([fvg("bullish", 10, 12, 1), fvg("bearish", 11, 13, 2)])).toHaveLength(2);
  });
});
