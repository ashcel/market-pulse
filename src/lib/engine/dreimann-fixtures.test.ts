import { describe, expect, it } from "vitest";

import {
  DREIMANN_TRADES,
  labelTime,
  loadDreimannFixture,
  type DreimannFixture,
} from "./__fixtures__/dreimann";

/**
 * Data-integrity smoke tests for the frozen Dreimann ground-truth fixtures.
 * These prove the captured klines and the hand labels are mutually coherent —
 * they make no engine assertions. The annotation-fidelity tests that judge
 * strength/equilibrium logic against these labels live with those modules.
 */

const INTERVAL_SECONDS = { "15m": 900, "1h": 3600, "4h": 14400 } as const;

function executionSeries(fixture: DreimannFixture) {
  const candles = fixture.series[fixture.labels.executionTimeframe];
  expect(candles).toBeDefined();
  return candles!;
}

describe.each(DREIMANN_TRADES)("dreimann fixture %s", (name) => {
  const fixture = loadDreimannFixture(name);

  it("has every captured series present, chronological, and gap-free", () => {
    expect(fixture.meta.windows.length).toBeGreaterThan(0);
    for (const window of fixture.meta.windows) {
      const step = INTERVAL_SECONDS[window.interval as keyof typeof INTERVAL_SECONDS];
      const candles = fixture.series[window.interval as keyof typeof fixture.series];
      expect(step).toBeDefined();
      expect(candles).toBeDefined();
      expect(candles!.length).toBeGreaterThan(50);
      for (const [i, candle] of candles!.entries()) {
        if (i > 0) expect(candle.time).toBe(candles![i - 1].time + step);
      }
    }
  });

  it("has sane OHLCV on every bar", () => {
    for (const candles of Object.values(fixture.series)) {
      for (const c of candles) {
        expect(Number.isFinite(c.open + c.high + c.low + c.close + c.volume)).toBe(true);
        expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
        expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
        expect(c.volume).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("labels agree with the captured data", () => {
    const { labels, meta } = fixture;
    expect(labels.symbol).toBe(meta.symbol);
    expect(labels.chart).toBe(meta.chart);

    const candles = executionSeries(fixture);
    const entryTime = labelTime(labels.entry.approxTimeUtc);
    // The entry lands inside the execution window and on a bar boundary.
    expect(entryTime).toBeGreaterThanOrEqual(candles[0].time);
    expect(entryTime).toBeLessThanOrEqual(candles[candles.length - 1].time);
    expect(candles.some((c) => c.time === entryTime)).toBe(true);

    // Entry and stop are prices this market actually traded in the window.
    const low = Math.min(...candles.map((c) => c.low));
    const high = Math.max(...candles.map((c) => c.high));
    for (const price of [labels.entry.price, labels.stop.price]) {
      expect(price).toBeGreaterThanOrEqual(low * 0.99);
      expect(price).toBeLessThanOrEqual(high * 1.01);
    }
  });

  it("objective label matches pre-entry structure (or is marked beyond the window)", () => {
    const { labels } = fixture;
    const candles = executionSeries(fixture);
    const entryTime = labelTime(labels.entry.approxTimeUtc);
    const preEntry = candles.filter((c) => c.time < entryTime);
    expect(preEntry.length).toBeGreaterThan(0);

    if (labels.objective.withinWindow) {
      // A "weak high" objective must correspond to real prior structure: some
      // pre-entry bar printed a high within the label's tolerance of it.
      const tolerance = labels.objective.tolerancePct / 100;
      const near = preEntry.some(
        (c) => Math.abs(c.high - labels.objective.price) / labels.objective.price <= tolerance,
      );
      expect(near).toBe(true);
    } else {
      // Marked beyond the window: the objective must indeed exceed every
      // captured high, or the flag itself is mislabeled.
      const maxHigh = Math.max(...candles.map((c) => c.high));
      expect(labels.objective.price).toBeGreaterThan(maxHigh);
    }
  });
});

describe("dreimann labels file", () => {
  it("covers exactly the captured trades", () => {
    for (const name of DREIMANN_TRADES) {
      expect(() => loadDreimannFixture(name)).not.toThrow();
    }
  });
});
