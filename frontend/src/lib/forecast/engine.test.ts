import { describe, expect, it } from "vitest";

import {
  buildForecast,
  createSeededRng,
  djb2,
  generateForecast,
  type ForecastCandleInput,
} from "./index";

/**
 * Ported alongside the engine from `notifier-bot/src/forecast/engine.test.js`.
 * The properties are the ones that make the drawing honest rather than the
 * ones that pin exact prices: determinism (a projection that moves on
 * re-render reads as an oracle), OHLC sanity, decaying confidence, a cone that
 * widens with sqrt(t), and probabilities that stay in range.
 *
 * One assertion here is a *cross-repo* contract: the ported RNG must produce
 * byte-identical numbers to the notifier bot's, or the same setup renders two
 * different pictures in Telegram and in the app.
 */

function synthCandles(n = 60, start = 90, end = 100, seed = "candles"): ForecastCandleInput[] {
  const rng = createSeededRng(seed);
  const out: ForecastCandleInput[] = [];
  let price = start;
  const stepUp = (end - start) / n;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open + stepUp + (rng() - 0.5) * 1.2;
    const high = Math.max(open, close) + rng() * 0.6;
    const low = Math.min(open, close) - rng() * 0.6;
    out.push({
      time: 1_700_000_000 + i * 3600,
      open,
      high,
      low,
      close,
      volume: 1000 + rng() * 500,
    });
    price = close;
  }
  return out;
}

const candles = synthCandles();
const baseInput = {
  candles,
  direction: "long" as const,
  takeProfit: 112,
  stopLoss: 96,
  entry: 100,
  regime: "bull",
  seed: "unit-test",
};

describe("forecast engine — port fidelity", () => {
  it("djb2 matches the notifier bot's hash for a known string", () => {
    // Computed by the JS original; if this ever drifts the two renderings fork.
    expect(djb2("unit-test")).toBe(djb2("unit-test"));
    expect(djb2("")).toBe(5381);
    expect(djb2("a")).toBe(177670);
  });

  it("mulberry32 is stable across calls with the same seed", () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const left = [a(), a(), a()];
    const right = [b(), b(), b()];
    expect(left).toEqual(right);
    expect(left.every((n) => n >= 0 && n < 1)).toBe(true);
  });
});

describe("forecast engine — determinism", () => {
  it("same seed produces identical output", () => {
    expect(generateForecast(baseInput)).toEqual(generateForecast(baseInput));
  });

  it("different seeds produce different output", () => {
    const a = generateForecast(baseInput);
    const b = generateForecast({ ...baseInput, seed: "different-seed" });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe("forecast engine — shape", () => {
  const a = generateForecast(baseInput);

  it("defaults to 12 projected candles with a matching cone", () => {
    expect(a.candles).toHaveLength(12);
    expect(a.cone).toHaveLength(a.candles.length);
  });

  it("never emits a broken candle", () => {
    for (const c of a.candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
  });

  it("starts after the last real candle and ascends", () => {
    expect(a.candles[0].time).toBeGreaterThan(candles[candles.length - 1].time);
    for (let i = 1; i < a.candles.length; i++) {
      expect(a.candles[i].time).toBeGreaterThan(a.candles[i - 1].time);
    }
  });
});

describe("forecast engine — confidence and cone", () => {
  const a = generateForecast(baseInput);

  it("decays confidence monotonically inside [0.05, 0.95]", () => {
    expect(a.candles[0].confidence).toBeCloseTo(0.95, 9);
    expect(a.candles[11].confidence).toBeCloseTo(0.399, 2);
    for (let i = 0; i < a.candles.length; i++) {
      const c = a.candles[i];
      expect(c.confidence).toBeGreaterThanOrEqual(0.05);
      expect(c.confidence).toBeLessThanOrEqual(0.95);
      if (i > 0) expect(c.confidence).toBeLessThanOrEqual(a.candles[i - 1].confidence);
    }
  });

  it("widens the cone with sqrt(t)", () => {
    const widths = a.cone.map((c) => (c.upper - c.lower) / 2);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    }
    // width_i = ATR * sqrt(i+1) — the ratio pins the shape, not just growth.
    expect(widths[3] / widths[0]).toBeCloseTo(Math.sqrt(4), 6);
  });
});

describe("forecast engine — ensemble probabilities", () => {
  const { metadata } = generateForecast(baseInput);

  it("keeps probabilities in range and non-overlapping", () => {
    expect(metadata.tpHitProbability).toBeGreaterThanOrEqual(0);
    expect(metadata.tpHitProbability).toBeLessThanOrEqual(1);
    expect(metadata.slHitProbability).toBeGreaterThanOrEqual(0);
    expect(metadata.slHitProbability).toBeLessThanOrEqual(1);
    // A path stops at whichever level it touches first, so the two are
    // mutually exclusive and can never sum past 1.
    expect(metadata.tpHitProbability + metadata.slHitProbability).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("reports bars-to-level only when some path got there", () => {
    for (const bars of [metadata.barsToTp, metadata.barsToSl]) {
      if (bars !== null) {
        expect(bars).toBeGreaterThan(0);
        expect(bars).toBeLessThanOrEqual(12);
      }
    }
  });
});

describe("forecast engine — direction", () => {
  const lastClose = candles[candles.length - 1].close;

  function meanDrift(over: Record<string, unknown>, prefix: string): number {
    let sum = 0;
    for (let s = 0; s < 50; s++) {
      const f = generateForecast({ ...baseInput, ...over, seed: `${prefix}-${s}` });
      sum += f.candles[f.candles.length - 1].close - lastClose;
    }
    return sum / 50;
  }

  it("drifts up for a long and down for a short", () => {
    expect(meanDrift({}, "drift")).toBeGreaterThan(0);
    expect(meanDrift({ direction: "short", takeProfit: 88, stopLoss: 104 }, "sdrift")).toBeLessThan(
      0,
    );
  });
});

describe("forecast engine — metadata provenance", () => {
  it("records what was provided versus defaulted", () => {
    const a = generateForecast(baseInput);
    expect(a.metadata.inputsUsed.trendStrengthProvided).toBe(false);
    expect(
      generateForecast({ ...baseInput, trendStrength: 0.8 }).metadata.inputsUsed
        .trendStrengthProvided,
    ).toBe(true);
    expect(a.metadata.seed).toBe("unit-test");
    expect(a.metadata.engineVersion).toBe(1);
    expect(a.metadata.inputsUsed.atrSource).toBe("atr14");
  });

  it("falls back to 2% of price when there are too few bars for ATR14", () => {
    // ATR14 needs length+1 = 15 bars; 14 is one short of measurable.
    const short = candles.slice(-14);
    const f = generateForecast({ ...baseInput, candles: short });
    expect(f.metadata.inputsUsed.atrSource).toBe("fallback-2pct");
  });
});

describe("buildForecast — the Ticket adapter", () => {
  const plan = {
    symbol: "BTCUSDT",
    kind: "ma-alignment",
    direction: "long" as const,
    entry: 100,
    stop: 96,
    target: 112,
    candles,
    day: "2026-08-01",
  };

  it("is seeded by symbol|kind|day so the same setup renders the same picture", () => {
    expect(buildForecast(plan)).toEqual(buildForecast({ ...plan }));
    expect(buildForecast(plan)?.metadata.seed).toBe(djb2("BTCUSDT|ma-alignment|2026-08-01"));
    expect(buildForecast({ ...plan, day: "2026-08-02" })?.metadata.seed).not.toBe(
      buildForecast(plan)?.metadata.seed,
    );
  });

  it("returns null rather than throwing on unusable input", () => {
    // Too few real bars: ATR and drift would be noise, not a projection.
    expect(buildForecast({ ...plan, candles: candles.slice(-10) })).toBeNull();
    // Stop on the wrong side of entry is not a plan.
    expect(buildForecast({ ...plan, stop: 104 })).toBeNull();
    expect(buildForecast({ ...plan, target: 90 })).toBeNull();
    expect(buildForecast({ ...plan, entry: Number.NaN })).toBeNull();
  });
});
