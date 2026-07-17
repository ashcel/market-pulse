import { describe, expect, it } from "vitest";

import {
  buildDemoScan,
  DEFAULT_GATES,
  parseTicker24hAll,
  scanSpikes,
  scoreOpportunities,
  type MarketOpportunity,
  type Ticker24h,
} from "./discovery";
import { REF_WINDOW } from "./spike";
import type { Candle } from "./types";

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

function rawTicker(symbol: string, overrides: Record<string, unknown> = {}) {
  return {
    symbol,
    lastPrice: "100",
    priceChangePercent: "2.5",
    highPrice: "104",
    lowPrice: "96",
    weightedAvgPrice: "100",
    quoteVolume: "150000000",
    count: 500_000,
    ...overrides,
  };
}

describe("parseTicker24hAll", () => {
  it("keeps only well-formed USDT pairs", () => {
    const rows = parseTicker24hAll([
      rawTicker("SOLUSDT"),
      rawTicker("SOLBTC"), // non-USDT quote
      rawTicker("ETHUSDC"), // non-USDT quote
      rawTicker("ADAUSDT", { lastPrice: "not-a-number" }), // malformed
      { symbol: "XRPUSDT" }, // missing fields
      "garbage",
      null,
    ]);
    expect(rows.map((r) => r.ticker)).toEqual(["SOL"]);
    expect(rows[0]).toMatchObject({ lastPrice: 100, quoteVolume24h: 150_000_000 });
  });

  it("excludes stable, fiat, wrapped, and leveraged bases", () => {
    const rows = parseTicker24hAll([
      rawTicker("USDCUSDT"),
      rawTicker("FDUSDUSDT"),
      rawTicker("EURUSDT"),
      rawTicker("WBTCUSDT"),
      rawTicker("PAXGUSDT"),
      rawTicker("BTCUPUSDT"),
      rawTicker("ETHDOWNUSDT"),
      rawTicker("EOSBULLUSDT"),
    ]);
    expect(rows).toEqual([]);
  });

  it("does not mistake real tickers ending in UP for leveraged tokens", () => {
    const rows = parseTicker24hAll([rawTicker("JUPUSDT")]);
    expect(rows.map((r) => r.ticker)).toEqual(["JUP"]);
  });

  it("returns [] for non-array payloads", () => {
    expect(parseTicker24hAll({ code: -1 })).toEqual([]);
    expect(parseTicker24hAll(undefined)).toEqual([]);
  });
});

describe("scoreOpportunities gates", () => {
  it("drops sub-floor pairs entirely, no matter how volatile", () => {
    const thin = row({
      ticker: "THIN",
      quoteVolume24h: DEFAULT_GATES.minQuoteVolume24h - 1,
      highPrice: 160,
      lowPrice: 80, // 80% range
    });
    const lowTrades = row({
      ticker: "WASH",
      trades24h: DEFAULT_GATES.minTrades24h - 1,
      highPrice: 160,
      lowPrice: 80,
    });
    const ranked = scoreOpportunities([thin, lowTrades, row({ ticker: "OK" })]);
    expect(ranked.map((o) => o.ticker)).toEqual(["OK"]);
  });

  it("ranks only the top liquidity tier even when many pairs clear the floor", () => {
    const rows = Array.from({ length: DEFAULT_GATES.liquidityTierSize + 20 }, (_, i) =>
      row({
        ticker: `T${i}`,
        // T0 is the most liquid, each subsequent pair a step thinner.
        quoteVolume24h: 2_000_000_000 - i * 15_000_000,
        // The thinnest pair is also the wildest — tier cut must still exclude it.
        highPrice: 100 + i * 0.5,
        lowPrice: 95,
      }),
    );
    const ranked = scoreOpportunities(rows);
    expect(ranked).toHaveLength(DEFAULT_GATES.liquidityTierSize);
    const tickers = new Set(ranked.map((o) => o.ticker));
    expect(tickers.has(`T${DEFAULT_GATES.liquidityTierSize}`)).toBe(false);
    expect(tickers.has("T0")).toBe(true);
  });
});

describe("scoreOpportunities ranking", () => {
  // A pair barely above the liquidity floor with an extreme range must not
  // outrank a deep, active pair in a genuine (smaller) expansion.
  it("does not let barely-liquid volatility beat deep-liquidity movement", () => {
    const rows: Ticker24h[] = [
      row({
        ticker: "THIN",
        quoteVolume24h: DEFAULT_GATES.minQuoteVolume24h + 1_000_000,
        trades24h: DEFAULT_GATES.minTrades24h + 5_000,
        highPrice: 230,
        lowPrice: 100, // ~80% range — scan-wide max volatility by far
      }),
      row({
        ticker: "SOLID",
        quoteVolume24h: 900_000_000,
        trades24h: 2_000_000,
        highPrice: 112,
        lowPrice: 100, // ~12% range — elevated but not extreme
      }),
      // Quiet liquid filler so percentiles have a real distribution.
      ...Array.from({ length: 8 }, (_, i) =>
        row({
          ticker: `F${i}`,
          quoteVolume24h: 60_000_000 + i * 10_000_000,
          trades24h: 120_000 + i * 10_000,
          highPrice: 102 + i * 0.1,
          lowPrice: 99,
        }),
      ),
    ];
    const ranked = scoreOpportunities(rows);
    const order = ranked.map((o) => o.ticker);
    expect(order.indexOf("SOLID")).toBeLessThan(order.indexOf("THIN"));
    expect(order[0]).toBe("SOLID");
  });

  it("is deterministic and returns the full ranked list, best first", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({
        ticker: `T${i}`,
        quoteVolume24h: 30_000_000 + i * 47_000_000,
        trades24h: 40_000 + i * 91_000,
        highPrice: 100 + (i % 5) * 3,
        lowPrice: 97,
      }),
    );
    const a = scoreOpportunities(rows);
    const b = scoreOpportunities([...rows].reverse());
    expect(a).toEqual(b);
    expect(a).toHaveLength(12);
    for (let i = 1; i < a.length; i++) expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score);
  });

  it("keeps every score and percentile inside 0-100 and stays non-directional", () => {
    const ranked = scoreOpportunities([
      row({ ticker: "A", highPrice: 300, lowPrice: 50 }),
      row({ ticker: "B", quoteVolume24h: 5_000_000_000, trades24h: 9_000_000 }),
      row({ ticker: "C" }),
    ]);
    for (const o of ranked) {
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(100);
      for (const pct of [o.volatilityPercentile, o.liquidityPercentile, o.activityPercentile]) {
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }
      // Discovery copy must never smuggle in a direction call.
      expect(o.reason).not.toMatch(/\b(long|short|buy|sell|bullish|bearish)\b/i);
    }
  });

  it("marks curated-universe tokens as tracked and resolves their names", () => {
    const ranked = scoreOpportunities([row({ ticker: "SOL" }), row({ ticker: "NEWCOIN" })]);
    const sol = ranked.find((o) => o.ticker === "SOL");
    const newcoin = ranked.find((o) => o.ticker === "NEWCOIN");
    expect(sol).toMatchObject({ tracked: true, name: "Solana" });
    expect(newcoin).toMatchObject({ tracked: false, name: "NEWCOIN" });
  });
});

describe("buildDemoScan", () => {
  it("is deterministic and clearly labeled demo", () => {
    const a = buildDemoScan();
    const b = buildDemoScan();
    expect(a.source).toBe("demo");
    expect(a.opportunities).toEqual(b.opportunities);
    expect(a.opportunities.length).toBeGreaterThan(0);
    expect(a.opportunities.length).toBeLessThanOrEqual(12);
    expect(a.spikes).toEqual([]);
  });
});

describe("scanSpikes", () => {
  function opp(ticker: string): MarketOpportunity {
    return {
      ticker,
      name: ticker,
      price: 100,
      change24h: 0,
      rangePercent24h: 0,
      quoteVolume24h: 0,
      trades24h: 0,
      score: 0,
      volatilityPercentile: 0,
      liquidityPercentile: 0,
      activityPercentile: 0,
      tracked: false,
      reason: "",
    };
  }

  const calm = (): Candle[] =>
    Array.from({ length: REF_WINDOW }, (_, i) => ({
      time: i,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 1_000,
    }));

  const upSpikeReject = (): Candle[] => [
    ...calm(),
    { time: REF_WINDOW, open: 100, high: 110, low: 100, close: 100, volume: 8_000 },
  ];

  it("returns only pairs whose klines detect a spike, ranked by volume multiple", async () => {
    const klines: Record<string, Candle[]> = {
      AAA: calm(), // no spike
      BBB: upSpikeReject(), // volumeMult 8
      CCC: [
        ...calm(),
        { time: REF_WINDOW, open: 100, high: 110, low: 100, close: 100, volume: 12_000 }, // 12×
      ],
    };
    const hits = await scanSpikes([opp("AAA"), opp("BBB"), opp("CCC")], (t) =>
      Promise.resolve(klines[t] ?? []),
    );
    expect(hits.map((h) => h.ticker)).toEqual(["CCC", "BBB"]);
    expect(hits[0].spike.direction).toBe("up");
    expect(hits[0].tracked).toBe(false);
  });

  it("returns nothing when the tier is calm", async () => {
    const hits = await scanSpikes([opp("AAA"), opp("BBB")], () => Promise.resolve(calm()));
    expect(hits).toEqual([]);
  });
});
