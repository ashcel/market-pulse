import { describe, expect, it } from "vitest";

import {
  detectSpike,
  REF_WINDOW,
  REJECT_FRACTION,
  SPIKE_RANGE_MULT,
  SPIKE_VOLUME_MULT,
} from "./spike";
import type { Candle } from "./types";

function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Candle {
  return { time, open, high, low, close, volume };
}

/** A calm trailing reference: `count` flat unit-range bars at `price`, low volume. */
function calmRun(count: number, price = 100, range = 1, volume = 1_000, startTime = 0): Candle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(startTime + i, price, price + range / 2, price - range / 2, price, volume),
  );
}

/** An up-spike-and-reject bar: pushes far above, closes back near the open (big upper wick). */
function upSpikeReject(time: number, base = 100): Candle {
  // range 10 (≈10× the calm 1.0 range), closes at base so the whole 10 is upper wick.
  return candle(time, base, base + 10, base, base, 8_000);
}

describe("detectSpike", () => {
  it("flags a vertical up-spike on abnormal volume that closes rejected", () => {
    const candles = [...calmRun(REF_WINDOW), upSpikeReject(REF_WINDOW)];
    const event = detectSpike(candles);
    expect(event).not.toBeNull();
    expect(event).toMatchObject({ direction: "up", barsAgo: 0, time: REF_WINDOW });
    expect(event!.rangeMult).toBeGreaterThanOrEqual(SPIKE_RANGE_MULT);
    expect(event!.volumeMult).toBeGreaterThanOrEqual(SPIKE_VOLUME_MULT);
    expect(event!.rejectionFraction).toBeGreaterThanOrEqual(REJECT_FRACTION);
    expect(event!.reason).toMatch(/up-spike rejected/);
  });

  it("mirrors for a down-spike-and-reject (dominant lower wick)", () => {
    // range 10, closes back at base → whole 10 is the lower wick.
    const down = candle(REF_WINDOW, 100, 100, 90, 100, 8_000);
    const event = detectSpike([...calmRun(REF_WINDOW), down]);
    expect(event).toMatchObject({ direction: "down" });
    expect(event!.reason).toMatch(/down-spike rejected/);
  });

  it("does NOT flag a breakout: big range + big volume but closes at the high (no rejection wick)", () => {
    // A vertical bar that closes at its extreme is a breakout, not a rejection.
    const breakout = candle(REF_WINDOW, 100, 110, 100, 110, 8_000);
    expect(detectSpike([...calmRun(REF_WINDOW), breakout])).toBeNull();
  });

  it("does NOT flag a long-wick rejection on ordinary volume", () => {
    // Same rejection shape, but volume is in line with the calm reference.
    const quietWick = candle(REF_WINDOW, 100, 110, 100, 100, 1_100);
    expect(detectSpike([...calmRun(REF_WINDOW), quietWick])).toBeNull();
  });

  it("does NOT flag a high-volume bar that isn't vertical (range in line with history)", () => {
    const heavyButFlat = candle(REF_WINDOW, 100, 100.5, 99.5, 100, 8_000);
    expect(detectSpike([...calmRun(REF_WINDOW), heavyButFlat])).toBeNull();
  });

  it("ignores a qualifying spike that is older than the recency window", () => {
    // Spike, then two more calm bars push it out of the last-2-bars window.
    const candles = [
      ...calmRun(REF_WINDOW),
      upSpikeReject(REF_WINDOW),
      ...calmRun(2, 100, 1, 1_000, REF_WINDOW + 1),
    ];
    expect(detectSpike(candles)).toBeNull();
  });

  it("returns the most recent spike when two are in-window (minimal barsAgo)", () => {
    const candles = [
      ...calmRun(REF_WINDOW),
      upSpikeReject(REF_WINDOW),
      candle(REF_WINDOW + 1, 100, 100, 90, 100, 8_000), // down-spike, newer
    ];
    const event = detectSpike(candles);
    expect(event).toMatchObject({ direction: "down", barsAgo: 0 });
  });

  it("returns null without enough bars for a trailing reference", () => {
    expect(detectSpike([...calmRun(5), upSpikeReject(5)])).toBeNull();
  });

  it("returns null on a calm series with no spike", () => {
    expect(detectSpike(calmRun(REF_WINDOW + 5))).toBeNull();
  });
});
