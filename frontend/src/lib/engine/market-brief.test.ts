import { describe, expect, it } from "vitest";

import { buildMarketBrief, type BriefInput } from "./market-brief";
import type { MarketRegimeData } from "@/lib/types";

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);

function regime(over: Partial<MarketRegimeData> = {}): MarketRegimeData {
  return {
    regime: "Neutral",
    confidence: 58,
    trendStrength: "Medium",
    timeline: [],
    pillars: [
      { label: "Trend", score: 50, status: "neutral", description: "", displayValue: "Choppy" },
      { label: "Breadth", score: 42, status: "bearish", description: "" },
    ],
    ...over,
  } as MarketRegimeData;
}

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    regime: regime(),
    rotation: {
      flow: ["Meme", "DeFi", "Majors"],
      legs: [],
      strength: "Medium",
      confidence: 50,
      rankAgreement: 0.5,
      winning: "Majors",
      losing: "Meme",
    },
    sentiment: { label: "Neutral", score: 55, fearGreed: 55, source: "api" },
    technical: { label: "Mixed", score: 61 },
    volatility: { label: "Low", vix: 2.4, change: -0.1, spark: [] },
    upcomingHighImpact: [],
    now: NOW,
    ...over,
  };
}

describe("buildMarketBrief", () => {
  it("leads with the regime call and its rule confidence", () => {
    const brief = buildMarketBrief(input());
    expect(brief.lines[0].text).toContain("Neutral regime at 58% rule confidence");
    expect(brief.lines[0].tone).toBe("neutral");
  });

  it("maps each regime to its own sizing instruction", () => {
    expect(
      buildMarketBrief(input({ regime: regime({ regime: "Risk On" }) })).recommendation,
    ).toEqual(["Trade your plan", "Normal size", "Follow trend"]);
    expect(
      buildMarketBrief(input({ regime: regime({ regime: "Risk Off" }) })).recommendation,
    ).toEqual(["Sit out or scalp", "Tight risk", "No breakout chasing"]);
  });

  it("reads thin breadth as bearish and broad breadth as bullish", () => {
    const thin = buildMarketBrief(
      input({
        regime: regime({
          pillars: [{ label: "Breadth", score: 25, status: "bearish", description: "" }],
        }),
      }),
    );
    expect(thin.lines[1].tone).toBe("bearish");
    expect(thin.lines[1].text).toContain("rallies are thin");

    const broad = buildMarketBrief(
      input({
        regime: regime({
          pillars: [{ label: "Breadth", score: 72, status: "bullish", description: "" }],
        }),
      }),
    );
    expect(broad.lines[1].tone).toBe("bullish");
  });

  it("warns on high volatility", () => {
    const brief = buildMarketBrief(
      input({ volatility: { label: "High", vix: 6.8, change: 1.2, spark: [] } }),
    );
    const vol = brief.lines.find((l) => l.text.includes("Volatility high"));
    expect(vol?.tone).toBe("warning");
    expect(vol?.text).toContain("smaller size");
  });

  it("counts down to the soonest upcoming print and adds a flat-into-print instruction", () => {
    const brief = buildMarketBrief(
      input({
        upcomingHighImpact: [
          { title: "CPI", occursAt: new Date(NOW + 40 * 60_000).toISOString() },
          { title: "FOMC", occursAt: new Date(NOW + 26 * 3_600_000).toISOString() },
        ],
      }),
    );
    const last = brief.lines[brief.lines.length - 1];
    expect(last.text).toBe("CPI in 40m — expect a volatility window around the print.");
    expect(brief.recommendation).toContain("Flat into the print");
  });

  it("ignores prints that have already happened", () => {
    const brief = buildMarketBrief(
      input({
        upcomingHighImpact: [{ title: "CPI", occursAt: new Date(NOW - 3_600_000).toISOString() }],
      }),
    );
    expect(brief.lines[brief.lines.length - 1].text).toBe(
      "No high-impact macro prints on the radar today.",
    );
    expect(brief.recommendation).not.toContain("Flat into the print");
  });

  it("marks an estimated Fear & Greed read as estimated", () => {
    const brief = buildMarketBrief(
      input({ sentiment: { label: "Bearish", score: 27, fearGreed: 27, source: "proxy" } }),
    );
    expect(brief.lines.some((l) => l.text.includes("(estimated)"))).toBe(true);
  });
});
