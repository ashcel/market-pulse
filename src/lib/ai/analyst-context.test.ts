import { describe, expect, it } from "vitest";

import { EXTERNAL_CONTEXT_CHAR_BUDGET, buildAnalystSystem } from "./analyst-context";
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
});
