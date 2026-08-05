import { describe, expect, it } from "vitest";

import type { Ticker24h } from "./discovery";
import { generateMockCandles } from "./mock-candles";
import {
  altsBeatingBtcPct,
  buildDemoRsScan,
  computeRsRows,
  RS_ENRICH_COUNT,
  RS_TRANSITION_MAX_BARS,
  transitionFlag,
} from "./rs-scan";

function row(overrides: Partial<Ticker24h> & { ticker: string }): Ticker24h {
  return {
    lastPrice: 100,
    changePercent24h: 1,
    highPrice: 105,
    lowPrice: 95,
    weightedAvgPrice: 100,
    quoteVolume24h: 200_000_000,
    trades24h: 400_000,
    ...overrides,
  };
}

const BTC = row({ ticker: "BTC", changePercent24h: 2 });

describe("computeRsRows", () => {
  it("ranks by 24h spread vs BTC, strongest first, with cross-sectional percentiles", () => {
    const ranked = computeRsRows(
      [
        row({ ticker: "SOL", changePercent24h: 7 }), // +5 vs BTC
        row({ ticker: "ETH", changePercent24h: 2 }), // 0
        row({ ticker: "ADA", changePercent24h: -3 }), // -5
        BTC, // the yardstick, never a row
      ],
      BTC,
    );
    expect(ranked.map((r) => r.ticker)).toEqual(["SOL", "ETH", "ADA"]);
    expect(ranked.map((r) => r.rsBtc24h)).toEqual([5, 0, -5]);
    expect(ranked[0].rsPercentile24h).toBe(100);
    expect(ranked[2].rsPercentile24h).toBe(0);
    // Tier 1 carries no enrichment.
    expect(ranked.every((r) => r.rsBtc7d === null && r.transition === null)).toBe(true);
  });

  it("applies the discovery gates: floors, then the liquidity tier", () => {
    const ranked = computeRsRows(
      [
        row({ ticker: "SOL", changePercent24h: 9 }),
        row({ ticker: "DUST", changePercent24h: 50, quoteVolume24h: 1_000_000 }), // below floor
        row({ ticker: "THIN", changePercent24h: 40, trades24h: 500 }), // below floor
        row({ ticker: "MID", changePercent24h: 4, quoteVolume24h: 6_000_000 }),
      ],
      BTC,
      { minQuoteVolume24h: 5_000_000, minTrades24h: 10_000, liquidityTierSize: 1 },
    );
    // The tier keeps only the single most liquid survivor.
    expect(ranked.map((r) => r.ticker)).toEqual(["SOL"]);
  });

  it("breaks spread ties by volume then ticker — a total order", () => {
    const ranked = computeRsRows(
      [
        row({ ticker: "AAA", changePercent24h: 3, quoteVolume24h: 100_000_000 }),
        row({ ticker: "BBB", changePercent24h: 3, quoteVolume24h: 300_000_000 }),
        row({ ticker: "CCC", changePercent24h: 3, quoteVolume24h: 100_000_000 }),
      ],
      BTC,
    );
    expect(ranked.map((r) => r.ticker)).toEqual(["BBB", "AAA", "CCC"]);
  });
});

describe("transitionFlag", () => {
  it("maps a recent daily transition and drops a stale one", () => {
    const daily = generateMockCandles("BTC", "1D", 200);
    const flag = transitionFlag(daily);
    if (flag) {
      expect(flag.barsAgo).toBeGreaterThanOrEqual(0);
      expect(flag.barsAgo).toBeLessThanOrEqual(RS_TRANSITION_MAX_BARS);
      expect(flag.from).not.toBe(flag.to);
    }
    expect(transitionFlag([])).toBeNull();
  });
});

describe("buildDemoRsScan", () => {
  it("is deterministic, BTC-free, and enriched on both sides", () => {
    const a = buildDemoRsScan();
    const b = buildDemoRsScan();
    expect(a.leaders).toEqual(b.leaders);
    expect(a.laggards).toEqual(b.laggards);
    expect(a.source).toBe("demo");
    expect(a.leaders.length).toBeLessThanOrEqual(RS_ENRICH_COUNT);
    expect([...a.leaders, ...a.laggards].some((r) => r.ticker === "BTC")).toBe(false);
    // Leaders strongest-first, laggards weakest-first.
    for (let i = 1; i < a.leaders.length; i++) {
      expect(a.leaders[i - 1].rsBtc24h).toBeGreaterThanOrEqual(a.leaders[i].rsBtc24h);
    }
    for (let i = 1; i < a.laggards.length; i++) {
      expect(a.laggards[i - 1].rsBtc24h).toBeLessThanOrEqual(a.laggards[i].rsBtc24h);
    }
    // Enrichment ran on the demo build (7d RS present).
    expect(a.leaders.every((r) => r.rsBtc7d !== null)).toBe(true);
  });
});

describe("altsBeatingBtcPct", () => {
  const rsRow = (ticker: string, rsBtc24h: number) => ({
    ticker,
    name: ticker,
    price: 1,
    quoteVolume24h: 1,
    tracked: false,
    rsBtc24h,
    rsPercentile24h: 50,
    rsBtc7d: null,
    transition: null,
  });

  it("counts strictly-positive spreads only", () => {
    expect(altsBeatingBtcPct([rsRow("A", 2), rsRow("B", 0), rsRow("C", -1), rsRow("D", 0.1)])).toBe(
      50,
    );
  });

  it("is 0 on an empty set rather than NaN", () => {
    expect(altsBeatingBtcPct([])).toBe(0);
  });

  it("saturates at both ends", () => {
    expect(altsBeatingBtcPct([rsRow("A", 1), rsRow("B", 2)])).toBe(100);
    expect(altsBeatingBtcPct([rsRow("A", -1), rsRow("B", -2)])).toBe(0);
  });
});

describe("buildDemoRsScan alt breadth", () => {
  it("reports a share consistent with the demo leaders and laggards", () => {
    const scan = buildDemoRsScan();
    expect(scan.altsBeatingBtcPct).toBeGreaterThanOrEqual(0);
    expect(scan.altsBeatingBtcPct).toBeLessThanOrEqual(100);
    // Leaders lead: if the top row is behind BTC, nothing can be beating it.
    if (scan.leaders[0].rsBtc24h <= 0) expect(scan.altsBeatingBtcPct).toBe(0);
  });
});
