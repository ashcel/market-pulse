import { describe, expect, it } from "vitest";

import { classifyTokenEvents, detectEventAssets } from "./token-events";
import { parseRssItems } from "./news";
import type { RssItemRaw } from "./news";

function item(headline: string, description = "", overrides: Partial<RssItemRaw> = {}): RssItemRaw {
  return {
    headline,
    description,
    url: "https://example.com/a",
    guid: "guid-1",
    publishedAtMs: Date.parse("2026-07-12T00:00:00Z"),
    ...overrides,
  };
}

describe("detectEventAssets", () => {
  it("matches by full name case-insensitively and by ticker", () => {
    expect(detectEventAssets("Solana validators approve change")).toContain("SOL");
    expect(detectEventAssets("SOL rallies as ETH lags")).toEqual(
      expect.arrayContaining(["SOL", "ETH"]),
    );
  });

  it("requires exact uppercase for short tickers — prose words can't false-positive", () => {
    expect(detectEventAssets("a great photo op for the president")).not.toContain("OP");
    expect(detectEventAssets("the suspect fled to another ar ea")).not.toContain("AR");
    expect(detectEventAssets("OP mainnet fees drop after upgrade")).toContain("OP");
    // Longer tickers stay case-insensitive.
    expect(detectEventAssets("avax subnet growth")).toContain("AVAX");
  });

  it("matches worker-universe extension tokens, not just the dashboard 18", () => {
    expect(detectEventAssets("Celestia unlock schedule published")).toContain("TIA");
    expect(detectEventAssets("Arbitrum DAO vote passes")).toContain("ARB");
  });

  it("matches out-of-universe directory tickers, uppercase-exact only", () => {
    const directory = ["DEXE", "SXT", "SAND", "T"];
    expect(detectEventAssets("DEXE announces vesting cliff", directory)).toContain("DEXE");
    // Lowercase/prose forms of directory tickers never match — no names to
    // disambiguate with, so exact uppercase is the contract.
    expect(detectEventAssets("children play in the sand by the beach", directory)).toEqual([]);
    expect(detectEventAssets("dexe protocol update", directory)).toEqual([]);
    // 1-char bases are never matched — a bare capital letter is noise.
    expect(detectEventAssets("Model T production halted", directory)).toEqual([]);
  });

  it("stoplists uppercase acronyms that double as Binance bases", () => {
    const directory = ["AI", "NFT", "ID", "DEXE"];
    expect(detectEventAssets("AI tokens rally as NFT volumes slide", directory)).toEqual([]);
  });

  it("universe tokens keep priority and results stay capped at 4", () => {
    const directory = ["DEXE", "SXT", "OPN", "UTK"];
    const text = "SOL ETH ARB TIA DEXE SXT all unlock simultaneously";
    const found = detectEventAssets(text, directory);
    expect(found).toHaveLength(4);
    expect(found).toEqual(expect.arrayContaining(["SOL", "ETH", "ARB", "TIA"]));
  });

  it("does not double-report universe tickers passed in the directory", () => {
    // The live directory contains SOL etc. too — extras must skip them.
    expect(detectEventAssets("SOL validators pause network", ["SOL"])).toEqual(["SOL"]);
  });
});

describe("classifyTokenEvents", () => {
  it("classifies an exploit as critical security, winning over other matching kinds", () => {
    const events = classifyTokenEvents(
      [item("Curve pools drained in $5M exploit ahead of exchange listing on Binance")],
      "cointelegraph",
    );
    const crv = events.find((e) => e.symbol === "CRV");
    expect(crv).toBeDefined();
    expect(crv!.kind).toBe("security");
    expect(crv!.severity).toBe("critical");
  });

  it("classifies unlocks and regulatory actions as warnings", () => {
    const events = classifyTokenEvents(
      [
        item("Arbitrum to unlock $120M of ARB next week", "", { guid: "g-unlock" }),
        item("SEC sues over Solana sales", "", { guid: "g-reg" }),
      ],
      "coindesk",
    );
    expect(events.find((e) => e.symbol === "ARB")?.kind).toBe("unlock");
    expect(events.find((e) => e.symbol === "ARB")?.severity).toBe("warning");
    expect(events.find((e) => e.symbol === "SOL")?.kind).toBe("regulatory");
  });

  it("emits nothing without a token match or without a kind match", () => {
    expect(classifyTokenEvents([item("Massive exchange hack drains $100M")], "x")).toEqual([]);
    expect(classifyTokenEvents([item("Bitcoin price steady this weekend")], "x")).toEqual([]);
  });

  it("dedup keys are stable per (source, article, symbol, kind)", () => {
    const a = classifyTokenEvents([item("ETH unlock looms")], "src")[0];
    const b = classifyTokenEvents([item("ETH unlock looms")], "src")[0];
    expect(a.dedupKey).toBe(b.dedupKey);
    const other = classifyTokenEvents([item("ETH unlock looms")], "other-src")[0];
    expect(other.dedupKey).not.toBe(a.dedupKey);
  });

  it("produces typed events for out-of-universe tokens via the directory", () => {
    const events = classifyTokenEvents(
      [item("DEXE team wallet unlock scheduled for next month")],
      "cointelegraph",
      Date.now(),
      ["DEXE", "SXT"],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ symbol: "DEXE", kind: "unlock", severity: "warning" });
  });

  it("drops multi-asset roundup/listicle headlines whole", () => {
    const roundups = [
      "SOL, ADA, XRP price analysis: unlock season regulatory pressure builds",
      "Top 5 cryptos to watch this week: BTC ETH SOL upgrade lawsuits and more",
      "Weekly market wrap: DOGE PEPE WIF hack fears and vesting cliffs",
    ];
    for (const headline of roundups) {
      expect(classifyTokenEvents([item(headline)], "cointelegraph")).toHaveLength(0);
    }
  });

  it("keeps a genuine multi-asset story — a real incident isn't a listicle", () => {
    const events = classifyTokenEvents(
      [item("Bridge exploit drains funds from SOL, AVAX and NEAR ecosystems")],
      "cointelegraph",
    );
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((e) => e.kind === "security")).toBe(true);
  });

  it("requires a headline mention for info-severity kinds, not description-only", () => {
    // Listing kind (info): UNI only in the description → dropped.
    const buried = classifyTokenEvents(
      [item("Exchange announces new listings for Q3", "Uniswap listed on Upbit next week")],
      "cointelegraph",
    );
    expect(buried).toHaveLength(0);
    // Same story with the token in the headline → kept.
    const headline = classifyTokenEvents(
      [item("Uniswap listed on Upbit next week")],
      "cointelegraph",
    );
    expect(headline).toHaveLength(1);
    expect(headline[0]).toMatchObject({ symbol: "UNI", kind: "listing" });
    // Warning/critical kinds keep the wider net: description-only still records.
    const critical = classifyTokenEvents(
      [item("Major DeFi protocol suffers incident", "Aave contracts exploited overnight")],
      "cointelegraph",
    );
    expect(critical.some((e) => e.symbol === "AAVE" && e.kind === "security")).toBe(true);
  });

  it("classifies straight from parsed RSS XML end to end", () => {
    const xml = `<rss><channel>
      <item><title>Aave contract vulnerability patched after whitehat report</title>
        <link>https://example.com/aave</link><guid>aave-1</guid>
        <pubDate>Sat, 12 Jul 2026 08:00:00 GMT</pubDate>
        <description><![CDATA[Funds safe, says team.]]></description></item>
      <item><title>Weather is nice today</title><guid>x</guid></item>
    </channel></rss>`;
    const events = classifyTokenEvents(parseRssItems(xml), "cointelegraph");
    expect(events).toHaveLength(1);
    expect(events[0].symbol).toBe("AAVE");
    expect(events[0].kind).toBe("security");
    expect(events[0].publishedAt).toBe("2026-07-12T08:00:00.000Z");
  });
});
