import { describe, expect, it } from "vitest";

import {
  DEFAULT_FUNDING_BACKTEST_CONFIG,
  runFundingBacktest,
  simulateFundingInstance,
} from "./funding-backtest";
import type { FundingBacktestInstance } from "./funding-backtest";
import type { Candle } from "./types";

// Candle.time is in SECONDS (per binance.ts). We build one contiguous 1m
// window per instance spanning m=-20..+61 relative to settlement, so every
// window boundary the default config needs exists:
//   entry  = settlement − 15m   (index 5)
//   settle = settlement          (index 20)
//   hExit  = settlement + 2m     (index 22)
//   rExit  = settlement + 60m    (index 80)
const BASE_PRICE = 100;
const FIRST_MIN = -20;

/** Index into the window for a candle at relative minute `m`. */
function idx(m: number): number {
  return m - FIRST_MIN;
}

function flatWindow(settlementSec: number, price = BASE_PRICE): Candle[] {
  const candles: Candle[] = [];
  for (let m = FIRST_MIN; m <= 61; m++) {
    const t = settlementSec + m * 60;
    candles.push({ time: t, open: price, high: price, low: price, close: price, volume: 1 });
  }
  return candles;
}

function makeInstance(
  overrides: Partial<FundingBacktestInstance> & { settlementSec?: number } = {},
): FundingBacktestInstance {
  const settlementSec = overrides.settlementSec ?? 1_000_000;
  return {
    pair: "TESTUSDT",
    ticker: "TEST",
    settlementMs: settlementSec * 1000,
    settledRate: 0.01,
    intervalHours: 8,
    candles1m: overrides.candles1m ?? flatWindow(settlementSec),
    ...overrides,
  };
}

// Defaults: notional = 3 / (1/100) = 300; round-trip fees = 2·0.0005·300 = 0.30;
// funding at |rate|=0.01 = 0.01·300 = 3.00.
const NOTIONAL = 300;
const FEES = 0.3;

describe("simulateFundingInstance — harvest leg", () => {
  it("collects funding on the short side when rate is positive (flat price)", () => {
    const r = simulateFundingInstance(makeInstance({ settledRate: 0.01 }));
    expect(r).not.toBeNull();
    expect(r!.side).toBe("short");
    expect(r!.harvest.stopped).toBe(false);
    expect(r!.harvest.fundingUsd).toBeCloseTo(3.0, 6);
    expect(r!.harvest.priceMoveUsd).toBeCloseTo(0, 6);
    expect(r!.harvest.feesUsd).toBeCloseTo(FEES, 6);
    expect(r!.harvest.pnlUsd).toBeCloseTo(2.7, 6);
  });

  it("collects funding on the long side when rate is negative (flat price)", () => {
    const r = simulateFundingInstance(makeInstance({ settledRate: -0.01 }));
    expect(r!.side).toBe("long");
    expect(r!.harvest.fundingUsd).toBeCloseTo(3.0, 6);
    expect(r!.harvest.pnlUsd).toBeCloseTo(2.7, 6);
  });

  it("forfeits funding when stopped BEFORE settlement", () => {
    const candles = flatWindow(1_000_000);
    // Short stop = 100·1.01 = 101. Touch it 5 min before settlement.
    candles[idx(-5)] = { ...candles[idx(-5)], high: 101 };
    const r = simulateFundingInstance(makeInstance({ settledRate: 0.01, candles1m: candles }));
    expect(r!.harvest.stopped).toBe(true);
    expect(r!.harvest.fundingUsd).toBe(0);
    // Exit at stop 101 on a short: (100−101)/100·300 = −3.00; minus fees.
    expect(r!.harvest.priceMoveUsd).toBeCloseTo(-3.0, 6);
    expect(r!.harvest.pnlUsd).toBeCloseTo(-3.3, 6);
    expect(r!.harvest.maePct).toBeGreaterThanOrEqual(1);
  });

  it("applies the conservative stop tie-break and still credits post-settlement funding", () => {
    const candles = flatWindow(1_000_000);
    // 1 min AFTER settlement: candle both touches the short stop (high 101) AND
    // trades favorably (low 98). Conservative model takes the stop at 101.
    candles[idx(1)] = { ...candles[idx(1)], high: 101, low: 98 };
    const r = simulateFundingInstance(makeInstance({ settledRate: 0.01, candles1m: candles }));
    expect(r!.harvest.stopped).toBe(true);
    // Alive at settlement ⇒ funding received despite the later stop.
    expect(r!.harvest.fundingUsd).toBeCloseTo(3.0, 6);
    expect(r!.harvest.priceMoveUsd).toBeCloseTo(-3.0, 6);
    // −3.00 price + 3.00 funding − 0.30 fees = −0.30.
    expect(r!.harvest.pnlUsd).toBeCloseTo(-0.3, 6);
  });

  it("charges round-trip taker fees derived from notional", () => {
    const r = simulateFundingInstance(makeInstance());
    expect(r!.harvest.feesUsd).toBeCloseTo(
      2 * DEFAULT_FUNDING_BACKTEST_CONFIG.takerFeeRate * NOTIONAL,
      9,
    );
  });
});

describe("simulateFundingInstance — reversal leg", () => {
  it("runs an independent stop opposite the harvest side", () => {
    const candles = flatWindow(1_000_000);
    // Harvest (short) stays flat and clean; reversal (long) enters at +2 @100,
    // long stop = 99, touched at +30.
    candles[idx(30)] = { ...candles[idx(30)], low: 99 };
    const r = simulateFundingInstance(makeInstance({ settledRate: 0.01, candles1m: candles }));
    // Harvest unaffected.
    expect(r!.harvest.stopped).toBe(false);
    expect(r!.harvest.fundingUsd).toBeCloseTo(3.0, 6);
    // Reversal is long (opposite the short harvest) and stopped, no funding.
    expect(r!.reversal.stopped).toBe(true);
    expect(r!.reversal.fundingUsd).toBe(0);
    expect(r!.reversal.priceMoveUsd).toBeCloseTo(-3.0, 6);
    expect(r!.reversal.pnlUsd).toBeCloseTo(-3.3, 6);
  });
});

describe("simulateFundingInstance — skips bad input without crashing", () => {
  it("returns null on empty candles", () => {
    expect(simulateFundingInstance(makeInstance({ candles1m: [] }))).toBeNull();
  });

  it("returns null when the window is too short to cover the strategy", () => {
    const settlementSec = 1_000_000;
    const shortWindow = flatWindow(settlementSec).slice(0, 10); // only covers pre-settlement
    expect(simulateFundingInstance(makeInstance({ candles1m: shortWindow }))).toBeNull();
  });

  it("returns null on a zero rate", () => {
    expect(simulateFundingInstance(makeInstance({ settledRate: 0 }))).toBeNull();
  });
});

describe("runFundingBacktest — aggregation", () => {
  it("buckets instances by |rate| band", () => {
    const report = runFundingBacktest("TESTUSDT", "TEST", [
      makeInstance({ settledRate: 0.007, settlementSec: 1_000_000 }), // 0.5–1%
      makeInstance({ settledRate: 0.015, settlementSec: 2_000_000 }), // 1–2%
      makeInstance({ settledRate: 0.03, settlementSec: 3_000_000 }), // ≥2%
    ]);
    expect(report.n).toBe(3);
    expect(report.buckets.map((b) => b.label)).toEqual(["0.5–1%", "1–2%", "≥2%"]);
    expect(report.buckets.map((b) => b.n)).toEqual([1, 1, 1]);
    // Every flat instance collects funding ⇒ all winners.
    expect(report.buckets.map((b) => b.winRate)).toEqual([1, 1, 1]);
    expect(report.winRateHarvest).toBe(1);
  });

  it("builds a chronological equity curve and max drawdown", () => {
    // Winner (+2.70), loser (−3.30, stop before settlement), winner (+2.70).
    const loserCandles = flatWindow(2_000_000);
    loserCandles[idx(-5)] = { ...loserCandles[idx(-5)], high: 101 };
    const a = makeInstance({ settlementSec: 1_000_000 });
    const b = makeInstance({ settlementSec: 2_000_000, candles1m: loserCandles });
    const c = makeInstance({ settlementSec: 3_000_000 });

    // Pass out of order to exercise chronological sorting.
    const report = runFundingBacktest("TESTUSDT", "TEST", [c, a, b]);

    expect(report.equityCurve.map((p) => p.settlementMs)).toEqual([
      1_000_000_000, 2_000_000_000, 3_000_000_000,
    ]);
    expect(report.equityCurve.map((p) => Number(p.equity.toFixed(2)))).toEqual([2.7, -0.6, 2.1]);
    // Peak 2.70 at A, trough −0.60 at B ⇒ drawdown 3.30.
    expect(report.maxDrawdown).toBeCloseTo(3.3, 6);
    expect(report.totalPnl).toBeCloseTo(2.1, 6);
    expect(report.avgPnl).toBeCloseTo(0.7, 6);
    expect(report.medianPnl).toBeCloseTo(2.7, 6);
    expect(report.winRateHarvest).toBeCloseTo(2 / 3, 6);
    // Expectancy equals the mean by construction.
    expect(report.expectancy).toBeCloseTo(report.avgPnl, 6);
  });

  it("returns a well-formed zeroed report when nothing simulates", () => {
    const report = runFundingBacktest("TESTUSDT", "TEST", [
      makeInstance({ candles1m: [] }),
      makeInstance({ settledRate: 0 }),
    ]);
    expect(report.n).toBe(0);
    expect(report.totalPnl).toBe(0);
    expect(report.avgPnl).toBe(0);
    expect(report.medianPnl).toBe(0);
    expect(report.maxDrawdown).toBe(0);
    expect(report.winRateHarvest).toBe(0);
    expect(report.equityCurve).toEqual([]);
    expect(report.instances).toEqual([]);
    expect(report.buckets.map((b) => b.n)).toEqual([0, 0, 0]);
  });
});
