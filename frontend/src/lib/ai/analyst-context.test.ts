import { describe, expect, it } from "vitest";

import {
  ECON_CALENDAR_MAX_ITEMS,
  EXTERNAL_CONTEXT_CHAR_BUDGET,
  buildAnalystSystem,
  buildGeneralAnalystSystem,
  econCalendarBlock,
  type EconCalendarItem,
  type MarketConditionSummary,
} from "./analyst-context";
import { computePivots } from "@/lib/engine/analysis";
import { generateMockCandles } from "@/lib/engine/mock-candles";
import { evaluateSignal } from "@/lib/engine/quant";
import type {
  ContextEventItem,
  ExternalContext,
  UpcomingCatalystItem,
} from "@/lib/engine/external-context";

// One real engine evaluation as the base — the external-context section is
// what's under test; the technical sections just need honest shapes.
const candles = generateMockCandles("BTC", "1H", 200);
const evaluation = evaluateSignal("BTC", candles, computePivots(candles));

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString();
const daysAhead = (d: number) => new Date(NOW + d * 24 * 60 * 60_000).toISOString();

function emptyContext(): ExternalContext {
  return {
    symbol: "BTC",
    assembledAt: new Date(NOW).toISOString(),
    breadth: null,
    relative: null,
    recentCatalysts: null,
    recentHighImpact: null,
    upcoming: null,
    marketEvents: null,
    social: null,
    degradation: [],
  };
}

function contextWithBreadth(): ExternalContext {
  return {
    ...emptyContext(),
    breadth: {
      btcRegime: "Risk On",
      btcChange24hPct: 1.8,
      btcDominancePct: 58.43,
      btcDominanceDelta24hPp: 0.3,
      totalMcapUsd: 3.71e12,
      mcapChange24hPct: -0.91,
      fearGreed: 71,
      fearGreedLabel: "Greed",
      provenance: { source: "coingecko+binance", asOf: hoursAgo(0.2), stale: false },
    },
  };
}

function event(title: string, severity: string, agoHours: number): ContextEventItem {
  return {
    kind: "regulatory",
    severity,
    title,
    source: "cointelegraph",
    url: null,
    publishedAt: hoursAgo(agoHours),
  };
}

function unlock(percentOfSupply: number | null): UpcomingCatalystItem {
  return {
    symbol: "BTC",
    kind: "unlock",
    title: "Team & investor cliff unlock",
    occursAt: daysAhead(3),
    source: "coinmarketcal",
    url: null,
    percentOfSupply,
    votes: 41,
    confidencePct: 92,
  };
}

const build = (ctx: ExternalContext | null) =>
  buildAnalystSystem("BTC", "4H", evaluation, null, false, null, ctx);

describe("buildAnalystSystem external context section", () => {
  it("omits the section and its rules entirely when context is null or empty", () => {
    for (const ctx of [null, emptyContext()]) {
      const prompt = build(ctx);
      expect(prompt).not.toContain("External market context");
      expect(prompt).not.toContain("SECONDARY evidence");
    }
    // Baseline behavior unchanged: identical to the pre-feature prompt.
    expect(build(null)).toBe(build(emptyContext()));
  });

  it("renders the two organizing questions with breadth + both retrospective buckets", () => {
    const ctx: ExternalContext = {
      ...contextWithBreadth(),
      recentCatalysts: [event("ETF outflow day", "warning", 14)],
      recentHighImpact: [event("Exchange hack contained", "critical", 90)],
      upcoming: [unlock(null)],
    };
    const prompt = build(ctx);
    expect(prompt).toContain("## External market context (secondary evidence — see rules)");
    expect(prompt).toContain("### What might explain the current move?");
    expect(prompt).toContain("### What matters next (next 7 days)");
    expect(prompt).toContain("BTC dominance 58.43% (24h +0.3pp)");
    expect(prompt).toContain("total crypto mcap $3.71T (24h -0.91%)");
    expect(prompt).toContain("plausible contributors, not established causes");
    expect(prompt).toContain("Exchange hack contained");
  });

  it("includes the secondary-evidence rules only when the section is present", () => {
    const prompt = build(contextWithBreadth());
    expect(prompt).toContain("never 'because of' or 'driven by'");
    expect(prompt).toContain("never overrides a technical invalidation");
    expect(build(null)).not.toContain("never 'because of'");
  });

  it("labels an unsized unlock as a scheduling fact and a sized one as quantified", () => {
    const unsized = build({ ...contextWithBreadth(), upcoming: [unlock(null)] });
    expect(unsized).toContain(
      "SIZE UNKNOWN (treat as a scheduling fact, not a supply-pressure signal)",
    );
    expect(unsized).toContain(
      "scheduling fact only — never infer bearish (or any directional) impact",
    );
    const sized = build({ ...contextWithBreadth(), upcoming: [unlock(2.3)] });
    expect(sized).toContain("2.3% of supply unlocks (quantified supply catalyst)");
    expect(sized).not.toContain("SIZE UNKNOWN");
  });

  it("marks stale provenance in the rendered line", () => {
    const ctx = contextWithBreadth();
    ctx.breadth!.provenance = { source: "coingecko", asOf: hoursAgo(3), stale: true };
    expect(build(ctx)).toContain("(STALE, as of ");
  });

  it("stays under budget by dropping market-wide events, then older bucket items", () => {
    const long = (i: number) =>
      `Very long headline number ${i} — ${"x".repeat(150)} designed to overflow the budget`;
    const ctx: ExternalContext = {
      ...contextWithBreadth(),
      recentCatalysts: [1, 2, 3, 4].map((i) => event(long(i), "info", i)),
      recentHighImpact: [5, 6, 7].map((i) => event(long(i), "critical", 24 * 3 + i)),
      upcoming: [unlock(null)],
      marketEvents: [8, 9, 10].map((i) => ({ ...unlock(null), title: long(i), symbol: "ETH" })),
    };
    const prompt = build(ctx);
    const section = prompt.slice(prompt.indexOf("## External market context"));
    expect(section.length).toBeLessThanOrEqual(EXTERNAL_CONTEXT_CHAR_BUDGET + 200);
    // Market-wide events dropped first; symbol's own upcoming events survive.
    expect(section).not.toContain("Market-wide (BTC/ETH) events:");
    expect(section).toContain("Team & investor cliff unlock");
    // Titles are truncated, never dumped whole.
    expect(section).not.toContain("x".repeat(150));
  });

  it("reorders macro headlines ahead of plain recency so they survive the budget trim to top-2", () => {
    // Titles are truncated to a fixed length regardless of padding (see
    // EVENT_TITLE_MAX), so overflow has to come from item COUNT rather than
    // per-item size — 14 plain items plus 1 macro item, well past the real
    // service-layer cap, but this exercises the pure trim in isolation. The
    // Fed/macro headline is OLDEST (last in recency order) — a naive
    // recency-only trim would drop it; prioritization must move it ahead of
    // same-tier items so it survives.
    const pad = "x".repeat(160);
    const plain = Array.from({ length: 14 }, (_, i) =>
      event(`Item ${i + 1} ${pad}`, "info", i + 1),
    );
    const ctx: ExternalContext = {
      ...contextWithBreadth(),
      recentCatalysts: [
        ...plain,
        event(`Fed holds interest rates steady, Powell signals caution ${pad}`, "info", 999),
      ],
    };
    const prompt = build(ctx);
    const section = prompt.slice(prompt.indexOf("## External market context"));
    expect(section.length).toBeLessThanOrEqual(EXTERNAL_CONTEXT_CHAR_BUDGET + 200);
    const catalystsBlock = section.slice(section.indexOf("Recent catalysts for BTC"));
    expect(catalystsBlock).toContain("[MACRO]");
    expect(catalystsBlock).toContain("Fed holds interest rates steady");
    // A naive recency-only trim to top-2 would have kept only "Item 1"/"Item
    // 2" and dropped the (oldest) macro item entirely.
    expect(catalystsBlock).not.toContain("Item 13");
    expect(catalystsBlock).not.toContain("Item 14");
  });

  it("tags macro headlines with [MACRO] in the rendered line, leaves others untagged", () => {
    const ctx: ExternalContext = {
      ...contextWithBreadth(),
      recentCatalysts: [event("CPI inflation data comes in hot", "info", 1)],
      recentHighImpact: [event("Team announces roadmap update", "warning", 90)],
    };
    const prompt = build(ctx);
    expect(prompt).toContain("[MACRO] [info/regulatory]");
    expect(prompt).toContain("Team announces roadmap update");
    const roadmapLine = prompt
      .split("\n")
      .find((l) => l.includes("Team announces roadmap update"))!;
    expect(roadmapLine).not.toContain("[MACRO]");
  });
});

describe("economic calendar section", () => {
  function econItem(
    daysAhead_: number,
    impact: EconCalendarItem["impact"] = "high",
  ): EconCalendarItem {
    return {
      title: `Release ${daysAhead_}`,
      country: "US",
      impact,
      forecast: "3.1%",
      previous: "3.0%",
      occursAt: daysAhead(daysAhead_),
    };
  }

  it("returns null (and the section vanishes) with no events", () => {
    expect(econCalendarBlock([])).toBeNull();
    const prompt = build(emptyContext());
    expect(prompt).not.toContain("Upcoming economic calendar");
  });

  it("sorts soonest-first regardless of input order and caps to the max", () => {
    const shuffled = [econItem(5), econItem(1), econItem(3)];
    const block = econCalendarBlock(shuffled)!;
    const lines = block.split("\n");
    expect(lines[0]).toContain("Release 1");
    expect(lines[1]).toContain("Release 3");
    expect(lines[2]).toContain("Release 5");

    const many = Array.from({ length: ECON_CALENDAR_MAX_ITEMS + 5 }, (_, i) => econItem(i + 1));
    const cappedBlock = econCalendarBlock(many)!;
    expect(cappedBlock.split("\n").length).toBe(ECON_CALENDAR_MAX_ITEMS);
  });

  it("renders country/impact/forecast/previous and is included with rules in buildAnalystSystem", () => {
    const prompt = buildAnalystSystem("BTC", "4H", evaluation, null, false, null, null, [
      econItem(2, "high"),
    ]);
    expect(prompt).toContain(
      "## Upcoming economic calendar (next 7 days — scheduling facts, not signals)",
    );
    expect(prompt).toContain("[high] US:");
    expect(prompt).toContain("forecast 3.1%, previous 3.0%");
    expect(prompt).toContain("SCHEDULING FACT only");
  });

  it("omits the section and rules when econCalendar is null or empty", () => {
    const withNull = buildAnalystSystem("BTC", "4H", evaluation, null, false, null, null, null);
    const withEmpty = buildAnalystSystem("BTC", "4H", evaluation, null, false, null, null, []);
    for (const prompt of [withNull, withEmpty]) {
      expect(prompt).not.toContain("Upcoming economic calendar");
      expect(prompt).not.toContain("SCHEDULING FACT only");
    }
  });
});

describe("buildGeneralAnalystSystem (ungrounded sidebar mode)", () => {
  const condition: MarketConditionSummary = {
    regime: "Risk On",
    regimeConfidence: 68,
    rotationWinning: "Layer 1",
    rotationLosing: "DeFi",
    sectorsUp: 5,
    sectorsTotal: 8,
    fearGreed: 71,
    fearGreedLabel: "Greed",
    updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
  };

  it("renders a market-condition block answering 'what's the market condition?'", () => {
    const prompt = buildGeneralAnalystSystem(condition, null);
    expect(prompt).toContain("## Current market condition");
    expect(prompt).toContain("Regime: Risk On (confidence 68/100)");
    expect(prompt).toContain("capital flowing into Layer 1, out of DeFi");
    expect(prompt).toContain("Breadth: 5/8 tracked sectors positive");
    expect(prompt).toContain("Fear & Greed 71 (Greed)");
  });

  it("omits the market-condition block when null, without throwing", () => {
    const prompt = buildGeneralAnalystSystem(null, null);
    expect(prompt).not.toContain("Current market condition");
    expect(prompt).toContain("Market Pulse AI");
  });

  it("includes the economic calendar block alongside market condition", () => {
    const prompt = buildGeneralAnalystSystem(condition, [
      {
        title: "FOMC rate decision",
        country: "US",
        impact: "high",
        forecast: null,
        previous: null,
        occursAt: daysAhead(2),
      },
    ]);
    expect(prompt).toContain("## Current market condition");
    expect(prompt).toContain("## Upcoming economic calendar");
    expect(prompt).toContain("FOMC rate decision");
  });
});
