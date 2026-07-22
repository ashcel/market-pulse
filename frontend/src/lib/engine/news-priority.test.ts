import { describe, expect, it } from "vitest";

import { prioritizeNews, scoreNewsPriority, tickerMatchesTitle } from "./news-priority";

const TICKERS = ["BTC", "ETH", "SOL", "ONE", "OP", "SOXL"];

describe("tickerMatchesTitle", () => {
  it("matches ordinary tickers case-insensitively, word-boundaried", () => {
    expect(tickerMatchesTitle("BTC rallies past 70k", "BTC")).toBe(true);
    expect(tickerMatchesTitle("btc rallies past 70k", "BTC")).toBe(true);
    expect(tickerMatchesTitle("Traders eye Bitcoin ETF flows", "BTC")).toBe(false);
  });

  it("matches leveraged/long tickers like SOXL and unusual ones like SKHYNIX", () => {
    expect(tickerMatchesTitle("SOXL surges on chip rally", "SOXL")).toBe(true);
    expect(tickerMatchesTitle("soxl slides after earnings", "SOXL")).toBe(true);
    expect(tickerMatchesTitle("SKHYNIX posts record quarter", "SKHYNIX")).toBe(true);
  });

  it("requires exact ALL-CAPS or cashtag form for dictionary-word-ish tickers", () => {
    // The core product-owner example: "One small step" must not tag ticker ONE.
    expect(tickerMatchesTitle("One small step for crypto adoption", "ONE")).toBe(false);
    expect(tickerMatchesTitle("ONE surges 20% on partnership news", "ONE")).toBe(true);
    expect(tickerMatchesTitle("$ONE breaks out of range", "ONE")).toBe(true);
    expect(tickerMatchesTitle("Traders had a great photo op today", "OP")).toBe(false);
    expect(tickerMatchesTitle("OP mainnet upgrade goes live", "OP")).toBe(true);
    expect(tickerMatchesTitle("$OP unlock scheduled next week", "OP")).toBe(true);
  });

  it("guards against short/ambiguous tickers", () => {
    expect(tickerMatchesTitle("T-Mobile announces new plan", "T")).toBe(false);
  });
});

describe("scoreNewsPriority", () => {
  it("tags macro/economy headlines regardless of ticker mentions", () => {
    expect(
      scoreNewsPriority("Fed holds rates steady in latest FOMC decision", { tickers: TICKERS }),
    ).toMatchObject({ tier: "macro", isMacro: true });
    expect(
      scoreNewsPriority("CPI comes in hotter than expected", { tickers: TICKERS }),
    ).toMatchObject({ tier: "macro", isMacro: true });
  });

  it("tags tracked-ticker mentions when not macro", () => {
    const result = scoreNewsPriority("BTC and ETH both push higher", { tickers: TICKERS });
    expect(result.tier).toBe("ticker");
    expect(result.isMacro).toBe(false);
    expect(result.matchedTickers).toEqual(["BTC", "ETH"]);
  });

  it("macro takes priority over a ticker mention in the same title", () => {
    const result = scoreNewsPriority("BTC slides as Fed signals more rate hikes", {
      tickers: TICKERS,
    });
    expect(result.tier).toBe("macro");
    expect(result.matchedTickers).toContain("BTC");
  });

  it("falls back to 'other' when neither macro nor a tracked ticker matches", () => {
    expect(
      scoreNewsPriority("Weekly market wrap: top 5 altcoins to watch", { tickers: TICKERS }),
    ).toMatchObject({ tier: "other", isMacro: false, matchedTickers: [] });
  });
});

describe("prioritizeNews", () => {
  function item(title: string) {
    return { title };
  }

  it("brings macro and ticker items to the top, preserving recency within each tier", () => {
    const items = [
      item("Weekly roundup: top cryptos to watch"),
      item("BTC breaks above resistance"),
      item("Fed signals possible rate cut"),
      item("Random NFT drop announced"),
      item("ETH gas fees drop sharply"),
    ];
    const result = prioritizeNews(items, { tickers: TICKERS });
    expect(result.map((i) => i.title)).toEqual([
      "Fed signals possible rate cut",
      "BTC breaks above resistance",
      "ETH gas fees drop sharply",
      "Weekly roundup: top cryptos to watch",
      "Random NFT drop announced",
    ]);
  });

  it("is stable and deterministic across repeated calls", () => {
    const items = [item("SOL rallies"), item("BTC rallies"), item("Nothing notable happens")];
    const first = prioritizeNews(items, { tickers: TICKERS });
    const second = prioritizeNews(items, { tickers: TICKERS });
    expect(first.map((i) => i.title)).toEqual(second.map((i) => i.title));
  });

  it("does not mutate the input array", () => {
    const items = [item("Nothing notable"), item("BTC rallies")];
    const copy = [...items];
    prioritizeNews(items, { tickers: TICKERS });
    expect(items).toEqual(copy);
  });
});
