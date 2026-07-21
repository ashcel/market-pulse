import { describe, expect, it } from "vitest";

import { mapFundingRows, parseFundingIntervals } from "./funding-scan";

function premiumRow(symbol: string, overrides: Record<string, unknown> = {}) {
  return {
    symbol,
    markPrice: "150.50",
    indexPrice: "150.40",
    estimatedSettlePrice: "150.45",
    lastFundingRate: "0.0001",
    interestRate: "0.0001",
    nextFundingTime: 1_700_000_000_000,
    time: 1_699_999_000_000,
    ...overrides,
  };
}

describe("parseFundingIntervals", () => {
  it("maps symbol -> fundingIntervalHours", () => {
    const map = parseFundingIntervals([
      {
        symbol: "BTCUSDT",
        adjustedFundingRateCap: "0.02",
        adjustedFundingRateFloor: "-0.02",
        fundingIntervalHours: 4,
      },
      { symbol: "NOINTERVAL" }, // missing interval field, dropped
      "garbage",
      null,
    ]);
    expect(map.get("BTCUSDT")).toBe(4);
    expect(map.has("NOINTERVAL")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("returns an empty map for non-array payloads", () => {
    expect(parseFundingIntervals(null).size).toBe(0);
    expect(parseFundingIntervals(undefined).size).toBe(0);
    expect(parseFundingIntervals({ code: -1 }).size).toBe(0);
  });
});

describe("mapFundingRows", () => {
  it("keeps well-formed USDT perpetuals and strips the USDT suffix for ticker", () => {
    const rows = mapFundingRows([premiumRow("SOLUSDT")], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticker: "SOL",
      pair: "SOLUSDT",
      fundingRate: 0.0001,
      markPrice: 150.5,
      indexPrice: 150.4,
      nextFundingMs: 1_700_000_000_000,
      intervalHours: 8,
    });
  });

  it("joins the funding-interval map and defaults absent pairs to 8h", () => {
    const rows = mapFundingRows(
      [premiumRow("BTCUSDT"), premiumRow("ETHUSDT")],
      new Map([["BTCUSDT", 4]]),
    );
    expect(rows.find((r) => r.ticker === "BTC")?.intervalHours).toBe(4);
    expect(rows.find((r) => r.ticker === "ETH")?.intervalHours).toBe(8);
  });

  it("skips delivery/quarterly contracts and non-USDT quotes", () => {
    const rows = mapFundingRows(
      [
        premiumRow("BTCUSDT_250926"), // quarterly delivery contract
        premiumRow("BTCUSDC"), // USDC-margined, not USDT
        premiumRow("ETHBUSD"), // non-USDT quote
      ],
      new Map(),
    );
    expect(rows).toEqual([]);
  });

  it("drops rows with NaN/malformed/missing numeric fields", () => {
    const rows = mapFundingRows(
      [
        premiumRow("SOLUSDT", { lastFundingRate: "not-a-number" }),
        premiumRow("ADAUSDT", { markPrice: undefined }),
        premiumRow("XRPUSDT", { indexPrice: "" }),
        premiumRow("BNBUSDT", { nextFundingTime: undefined }),
        premiumRow("LTCUSDT", { markPrice: "0" }), // non-positive mark price
        { symbol: "DOGEUSDT" }, // missing everything but symbol
      ],
      new Map(),
    );
    expect(rows).toEqual([]);
  });

  it("returns [] for non-array payloads", () => {
    expect(mapFundingRows(null, new Map())).toEqual([]);
    expect(mapFundingRows({ code: -1 }, new Map())).toEqual([]);
    expect(mapFundingRows(undefined, new Map())).toEqual([]);
  });
});
