import { describe, expect, it } from "vitest";

import {
  fearGreedLabel,
  normalizeCoinGeckoGlobal,
  normalizeCoinMarketCapGlobal,
} from "./external-context";

/** A trimmed but shape-faithful CoinGecko /global response. */
const globalFixture = {
  data: {
    active_cryptocurrencies: 17468,
    total_market_cap: { usd: 3_710_000_000_000, eur: 3_420_000_000_000 },
    total_volume: { usd: 130_000_000_000 },
    market_cap_percentage: { btc: 58.43, eth: 11.21, usdt: 4.5 },
    market_cap_change_percentage_24h_usd: -0.91,
    updated_at: 1_752_400_000,
  },
};

describe("normalizeCoinGeckoGlobal", () => {
  it("extracts mcap, dominance, and 24h change from a /global payload", () => {
    const snap = normalizeCoinGeckoGlobal(globalFixture);
    expect(snap).toEqual({
      totalMcapUsd: 3_710_000_000_000,
      btcDominance: 58.43,
      ethDominance: 11.21,
      mcapChange24hPct: -0.91,
      source: "coingecko",
    });
  });

  it("tolerates missing optional fields (eth dominance, 24h change)", () => {
    const snap = normalizeCoinGeckoGlobal({
      data: {
        total_market_cap: { usd: 1e12 },
        market_cap_percentage: { btc: 60 },
      },
    });
    expect(snap).toEqual({
      totalMcapUsd: 1e12,
      btcDominance: 60,
      ethDominance: null,
      mcapChange24hPct: null,
      source: "coingecko",
    });
  });

  it("returns null on schema drift rather than producing a NaN row", () => {
    expect(normalizeCoinGeckoGlobal(null)).toBeNull();
    expect(normalizeCoinGeckoGlobal({})).toBeNull();
    expect(normalizeCoinGeckoGlobal({ data: {} })).toBeNull();
    expect(normalizeCoinGeckoGlobal({ data: { total_market_cap: { usd: "3.7T" } } })).toBeNull();
    expect(
      normalizeCoinGeckoGlobal({
        data: { total_market_cap: { usd: 1e12 }, market_cap_percentage: { btc: Number.NaN } },
      }),
    ).toBeNull();
    // Zero/negative mcap or dominance is provider garbage, not data.
    expect(
      normalizeCoinGeckoGlobal({
        data: { total_market_cap: { usd: 0 }, market_cap_percentage: { btc: 60 } },
      }),
    ).toBeNull();
  });
});

/** Trimmed but shape-faithful CoinMarketCap /v1/global-metrics/quotes/latest response. */
const cmcGlobalFixture = {
  status: { error_code: 0, credit_count: 1 },
  data: {
    active_cryptocurrencies: 9021,
    btc_dominance: 58.43,
    eth_dominance: 11.21,
    quote: {
      USD: {
        total_market_cap: 3_710_000_000_000,
        total_volume_24h: 130_000_000_000,
        total_market_cap_yesterday_percentage_change: -0.91,
      },
    },
  },
};

describe("normalizeCoinMarketCapGlobal", () => {
  it("extracts mcap, dominance, and 24h change from a global-metrics payload", () => {
    expect(normalizeCoinMarketCapGlobal(cmcGlobalFixture)).toEqual({
      totalMcapUsd: 3_710_000_000_000,
      btcDominance: 58.43,
      ethDominance: 11.21,
      mcapChange24hPct: -0.91,
      source: "coinmarketcap",
    });
  });

  it("tolerates missing optional fields", () => {
    expect(
      normalizeCoinMarketCapGlobal({
        data: { btc_dominance: 60, quote: { USD: { total_market_cap: 1e12 } } },
      }),
    ).toEqual({
      totalMcapUsd: 1e12,
      btcDominance: 60,
      ethDominance: null,
      mcapChange24hPct: null,
      source: "coinmarketcap",
    });
  });

  it("returns null on schema drift rather than producing a NaN row", () => {
    expect(normalizeCoinMarketCapGlobal(null)).toBeNull();
    expect(normalizeCoinMarketCapGlobal({})).toBeNull();
    expect(normalizeCoinMarketCapGlobal({ data: { btc_dominance: 60 } })).toBeNull();
    expect(
      normalizeCoinMarketCapGlobal({
        data: { btc_dominance: 0, quote: { USD: { total_market_cap: 1e12 } } },
      }),
    ).toBeNull();
  });
});

describe("fearGreedLabel", () => {
  it("maps the alternative.me bands", () => {
    expect(fearGreedLabel(80)).toBe("Extreme Greed");
    expect(fearGreedLabel(60)).toBe("Greed");
    expect(fearGreedLabel(50)).toBe("Neutral");
    expect(fearGreedLabel(30)).toBe("Fear");
    expect(fearGreedLabel(10)).toBe("Extreme Fear");
  });
});
