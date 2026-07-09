import { describe, it, expect } from "vitest";
import type { Candle, PivotPoint } from "./types";
import {
  classifySetup,
  classifyRegime,
  analyticsFor,
  buildRiskPlan,
  DEFAULT_RISK_SETTINGS,
} from "./quant";
import { computePivots } from "./analysis";

/**
 * Helper: Create candles for testing breakout logic
 */
function createCandles(closes: number[], volumes: number[] = []): Candle[] {
  const baseTime = 1000000;
  const step = 3600; // 1H candles
  return closes.map((close, i) => ({
    time: baseTime + i * step,
    open: close * 0.995,
    high: close * 1.001,
    low: close * 0.99,
    close,
    volume: volumes[i] ?? 1000, // Default to 1000 if not specified
  }));
}

describe("Breakout condition reachability", () => {
  it("detects successful breakout with sufficient volume", () => {
    // Setup: 30+ candles with a clear resistance level
    // Need proper pivot structure: high pivot at resistance, then consolidation, then breakout
    const closes = [
      // Build initial trend to establish pivot high
      ...Array.from({ length: 5 }, (_, i) => 90 + i),
      // Decline to establish pivot low
      ...Array.from({ length: 5 }, (_, i) => 95 - i),
      // Bounce to re-establish resistance near high
      ...Array.from({ length: 5 }, (_, i) => 90 + i),
      // Consolidation below resistance
      ...Array.from({ length: 13 }, () => 94),
      // prev: just at/below resistance
      99.5,
      // current: breaks above previous highs with volume
      100.5,
    ];
    const volumes = Array.from({ length: closes.length - 1 }, () => 1000);
    volumes.push(1500); // current volume: 1.5x average (meets 1.2x requirement)

    const candles = createCandles(closes, volumes);
    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    expect(setup).toBe("breakout");
  });

  it("fails to detect breakout without sufficient volume", () => {
    // Same as above but with low volume on the breakout candle
    const closes = Array.from({ length: 28 }, () => 95);
    closes.push(99);
    closes.push(101);
    closes.push(101.5); // Need 30 candles minimum
    const volumes = Array.from({ length: 28 }, () => 1000);
    volumes.push(1000);
    volumes.push(1000); // 1.0x average (below 1.2x requirement)
    volumes.push(1000);

    const candles = createCandles(closes, volumes);
    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    expect(setup).not.toBe("breakout");
  });

  it("fails to detect breakout when volume data is all zeros", () => {
    // All zero volumes - analytics.volumeRatio should be null
    const closes = Array.from({ length: 28 }, () => 95);
    closes.push(99);
    closes.push(101);
    const volumes = Array.from({ length: 30 }, () => 0);

    const candles = createCandles(closes, volumes);
    const analytics = analyticsFor(candles, computePivots(candles));

    // Verify volumeRatio is null when all volumes are zero
    expect(analytics.volumeRatio).toBe(null);

    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    // This is the unreachability issue: breakout should not be detected
    // when volume data is missing, but this might be a limitation rather than a bug
    expect(setup).not.toBe("breakout");
  });

  it("detects failed-breakout when price rejects at resistance", () => {
    // Setup: price attempts breakout but fails
    // Need: resistance level established, then a spike above it, then rejection below it
    const closes = [
      // Establish pivot structure with clear high pivot
      ...Array.from({ length: 5 }, (_, i) => 90 + i * 0.5),
      100, // Establish resistance pivot at 100
      99,
      98, // Drop from resistance
      // Consolidation below resistance - need 22 more candles to reach 30
      ...Array.from({ length: 22 }, () => 97),
      // Spike attempt above resistance (high will be > 100, close > 100)
      102.5,
      // Rejection: drop back below resistance
      98,
    ];

    const candles = createCandles(closes);
    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    expect(setup).toBe("failed-breakout");
  });

  it("requires both price and volume conditions for breakout", () => {
    // Price breaks out but volume is low
    const closes = Array.from({ length: 28 }, () => 95);
    closes.push(99);
    closes.push(101);
    const volumes = Array.from({ length: 30 }, () => 1000);
    volumes[29] = 1100; // Only 1.1x average

    const candles = createCandles(closes, volumes);
    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    expect(setup).not.toBe("breakout");
  });

  it("requires resistance to be defined for breakout", () => {
    // Create candles where no clear resistance can be identified
    // (e.g., all candles in downtrend with no pivot highs)
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
    const volumes = Array.from({ length: 30 }, () => 1500);

    const candles = createCandles(closes, volumes);
    const pivots = computePivots(candles);

    // In a pure downtrend, there might not be valid pivot-based resistance
    // Falls back to Math.max of last 20 candles' highs
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    // Expecting something other than breakout in a downtrend
    expect(setup).not.toBe("breakout");
  });

  // NOTE: "requires prev.close <= resistance condition" cannot be tested as an independent
  // black-box price scenario. Under the fallback path, resistance = max(high) over the 20
  // candles immediately before current -- and prev is *inside* that window. So resistance is
  // always >= prev.high >= prev.close whenever the fallback is used: `prev.close <= resistance`
  // is a structural tautology there, not a condition test data can violate. What the fix
  // actually changed is whether *current* leaks into that same window (see the two tests
  // below, which pin that directly against `analyticsFor`).
  it("excludes the current candle from the resistance fallback", () => {
    // Ascending series where the current (last) candle sets a brand-new high -- exactly the
    // shape that made resistance self-referential before the fix (resistance would have
    // equaled current.high, making `current.close > resistance` impossible).
    const closes = Array.from({ length: 30 }, (_, i) => 90 + i * 0.5);
    const candles = createCandles(closes);
    const pivots = computePivots(candles);
    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const analytics = analyticsFor(candles, pivots);

    expect(analytics.resistance).not.toBeNull();
    // Resistance must come from a prior candle, not the current one.
    expect(analytics.resistance).toBeLessThan(current.high);
    expect(analytics.resistance).toBeCloseTo(prev.high, 1);
  });

  it("excludes the current candle from the support fallback", () => {
    // Mirror of the above: descending series where the current candle sets a brand-new low.
    const closes = Array.from({ length: 30 }, (_, i) => 110 - i * 0.5);
    const candles = createCandles(closes);
    const pivots = computePivots(candles);
    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const analytics = analyticsFor(candles, pivots);

    expect(analytics.support).not.toBeNull();
    expect(analytics.support).toBeGreaterThan(current.low);
    expect(analytics.support).toBeCloseTo(prev.low, 1);
  });

  it("requires current.close > resistance condition", () => {
    // Volume is set well above the 1.2x gate on both variants below, so it cannot be the
    // reason either assertion passes -- only the current-close-vs-resistance comparison can be.
    // Resistance here comes from the fallback (prev's own high, ~99.099), NOT a round number
    // like 100 -- a naive "current close touches 100" fixture would have accidentally passed
    // for the wrong reason, since resistance never actually equals 100 in this data shape.
    const volumes = Array.from({ length: 29 }, () => 1000);
    volumes.push(1500); // 1.5x average, well above the 1.2x gate

    const prevClose = 99;
    const prevHigh = prevClose * 1.001; // matches createCandles' high = close * 1.001

    // current.close exactly equal to resistance (prev's high): the strict ">" must fail.
    const atThreshold = createCandles(
      [...Array.from({ length: 28 }, () => 95), prevClose, prevHigh],
      volumes,
    );
    const atPivots = computePivots(atThreshold);
    expect(classifySetup(atThreshold, atPivots, classifyRegime(atThreshold))).not.toBe("breakout");

    // current.close just a cent above resistance: same prev, same volume -- only the current
    // close moved. This proves the boundary is genuinely price-driven, not volume-driven.
    const pastThreshold = createCandles(
      [...Array.from({ length: 28 }, () => 95), prevClose, prevHigh + 0.01],
      volumes,
    );
    const pastPivots = computePivots(pastThreshold);
    expect(classifySetup(pastThreshold, pastPivots, classifyRegime(pastThreshold))).toBe(
      "breakout",
    );
  });

  it("handles edge case: exactly at resistance threshold", () => {
    // Adequate volume so the volume gate cannot be why this fails to trigger "breakout".
    const closes = Array.from({ length: 28 }, () => 95);
    closes.push(100); // prev: sets resistance (its high, ~100.1)
    closes.push(100.01); // current: still short of resistance
    const volumes = Array.from({ length: 29 }, () => 1000);
    volumes.push(1500);

    const candles = createCandles(closes, volumes);
    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    // Should not trigger breakout (prev.close must be <= not <, but current must be >)
    // So exactly at should not trigger
    expect(setup).not.toBe("breakout");
  });

  it("distinguishes breakout from pullback-continuation", () => {
    const closes = Array.from({ length: 28 }, () => 95);
    closes.push(96); // consolidation
    closes.push(97); // slight move up

    const candles = createCandles(closes);
    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    // This should not be classified as breakout (no resistance break)
    expect(setup).not.toBe("breakout");
  });

  it("analyzes volume ratio calculation", () => {
    const closes = Array.from({ length: 30 }, () => 100);
    const baseVolume = 1000;
    const volumes = Array.from({ length: 30 }, () => baseVolume);
    volumes[29] = baseVolume * 2; // Last candle is 2x average

    const candles = createCandles(closes, volumes);
    const pivots = computePivots(candles);
    const analytics = analyticsFor(candles, pivots);

    // Average of last 20 is 19*1000 + 1*2000 = 21000/20 = 1050
    // Current is 2000, ratio is 2000/1050 ≈ 1.90
    expect(analytics.volumeRatio).toBeCloseTo(1.9, 1);
  });

  it("handles missing candle data gracefully", () => {
    // Less than 30 candles (minimum for classifySetup)
    const candles = createCandles(Array.from({ length: 20 }, () => 100));
    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    expect(setup).toBe("no-clear-setup");
  });

  it("detects breakout when all conditions align", () => {
    // Comprehensive: clear resistance, clean breakout, high volume
    const closes = [
      // Initial trend up to establish high pivot
      ...Array.from({ length: 8 }, (_, i) => 90 + i * 0.5),
      // Correction down
      ...Array.from({ length: 6 }, (_, i) => 94 - i * 0.3),
      // Consolidation/base formation
      ...Array.from({ length: 10 }, () => 91),
      // Approaching resistance quietly
      92,
      93,
      94,
      95,
      96,
      // prev: just below previous high
      99.5,
      // current: breaks above with conviction
      100.5,
    ];

    const volumes = Array.from({ length: closes.length - 1 }, () => 1000);
    volumes.push(1800); // 1.8x average

    const candles = createCandles(closes, volumes);
    const pivots = computePivots(candles);
    const regime = classifyRegime(candles);
    const setup = classifySetup(candles, pivots, regime);

    expect(setup).toBe("breakout");
  });

  it("does not let the current candle's own extreme leak into buildRiskPlan's stop", () => {
    // Same self-reference shape as the resistance/support tests above, but exercised through
    // the second real consumer of nearestSupport/nearestResistance: buildRiskPlan's stop-loss.
    // A flat consolidation around 99, then the current candle drops hard to a brand-new low.
    // Pre-fix, the fallback support would have equaled current.low (95.04) -- the stop would
    // have been anchored to the very candle it's supposed to protect against. Post-fix, support
    // comes from the prior consolidation (~98.01) and is not the binding term, so the stop
    // falls back to the ATR-scaled distance instead.
    const closes = [...Array.from({ length: 28 }, () => 99), 99.2, 96];
    const candles = createCandles(closes);
    const pivots = computePivots(candles);
    const current = candles[candles.length - 1];
    const analytics = analyticsFor(candles, pivots);

    // Pin the fix at the analytics layer: support must not be the current candle's own low.
    expect(analytics.support).not.toBeCloseTo(current.low, 1);

    const plan = buildRiskPlan(candles, pivots, "long", DEFAULT_RISK_SETTINGS);

    // Pin it at the risk-plan layer too: the stop must not be anchored to current.low.
    // (A loose toBeCloseTo(x, 1) would be misleading here -- the buggy and fixed values are
    // only ~0.04 apart in this fixture, well inside that tolerance -- so this needs a tight
    // explicit distance check instead of a rounded comparison.)
    expect(Math.abs(plan.stop - current.low)).toBeGreaterThan(0.01);
    // It should instead reflect the ATR-scaled distance from entry (the correct fallback
    // once support is no longer self-referential and stops being the binding Math.min term).
    const atrOnlyStop = plan.entry - (analytics.atr14 ?? 0) * 0.7;
    expect(plan.stop).toBeCloseTo(atrOnlyStop, 2);
  });
});
